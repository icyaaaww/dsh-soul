import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hash, id, day, clean, bounded, redact, redactData, redactText, terms as termSet, sameTask, entities, NODE_TERMS } from './util.js'
import { segment } from './span-index.js'

export const SCHEMA_VERSION = 9

/** Retention caps for the two append-only tables. Oldest rows go first. */
export const MAX_SPANS_PER_SCOPE = 20000
export const MAX_ACTIVATIONS_PER_SCOPE = 20000

const jsonText = value => value === null || value === undefined ? null : bounded(JSON.stringify(redactData(value)), 4000)
const parseJson = (value, fallback) => {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

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
  constructor(path, { now = Date.now, maxNodes = 500 } = {}) {
    this.now = now
    // The configured cap, so the automatic prune after every write honours `memory.maxNodes`
    // instead of a hard-coded 500 that only `/mem prune` could override.
    this.maxNodes = maxNodes
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;`)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`数据库版本 ${version} 高于插件支持的 ${SCHEMA_VERSION}`)
    }
    try {
      // The span index is derived data, so a shape change drops and rebuilds it. That rebuild
      // must happen exactly once, on migration — putting it in the CREATE block below wiped the
      // index on every process start, which silently destroyed cross-session memory.
      if (version > 0 && version < 6) {
        this.db.exec('DROP TABLE IF EXISTS span_fts; DROP TABLE IF EXISTS span; DROP TABLE IF EXISTS span_meta;')
      }
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
          lesson TEXT,
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

        CREATE TABLE IF NOT EXISTS lesson(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          terms TEXT NOT NULL,
          task_key TEXT NOT NULL,
          task TEXT,
          summary TEXT NOT NULL,
          detail TEXT,
          success TEXT,
          divergence TEXT,
          trajectory TEXT,
          support INTEGER NOT NULL DEFAULT 1,
          contradictions INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'observed',
          episode TEXT,
          rev TEXT,
          last_reason TEXT,
          last_attempt INTEGER,
          created INTEGER NOT NULL,
          seen INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS lesson_scope ON lesson(scope, state, seen);
        CREATE INDEX IF NOT EXISTS lesson_rev ON lesson(rev);

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

        -- Memory skeleton (1.5). State, not policy: no revision tree, no gate, no model call.
        CREATE TABLE IF NOT EXISTS node(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          claim TEXT NOT NULL,
          terms TEXT NOT NULL,
          anchor TEXT,
          hash TEXT,
          source TEXT,
          seq INTEGER NOT NULL DEFAULT 0,
          pin INTEGER NOT NULL DEFAULT 0,
          valid_from INTEGER NOT NULL,
          valid_to INTEGER,
          recorded_at INTEGER NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          support INTEGER NOT NULL DEFAULT 1,
          hits INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'active',
          created INTEGER NOT NULL,
          seen INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS node_scope ON node(scope, state, kind, seen);
        CREATE INDEX IF NOT EXISTS node_anchor ON node(scope, anchor);

        CREATE TABLE IF NOT EXISTS edge(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          rel TEXT NOT NULL,
          w REAL NOT NULL DEFAULT 1.0,
          created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS edge_scope ON edge(scope, src);
        CREATE INDEX IF NOT EXISTS edge_dst ON edge(scope, dst);

        -- Addressable span index (1.10). Derived data: it is rebuilt from the logs, so schema
        -- changes drop and recreate rather than migrate.
        --
        -- session is part of the identity. Sequence numbers restart at zero in every session,
        -- so a project-wide index keyed only by (scope, seq) cannot tell two sessions apart —
        -- and a project-wide watermark silently skips every session after the first.
        CREATE TABLE IF NOT EXISTS span(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          session TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT '',
          hash TEXT NOT NULL,
          text TEXT NOT NULL,
          bytes INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS span_hash ON span(scope, hash);
        CREATE INDEX IF NOT EXISTS span_seq ON span(scope, session, seq);
        CREATE TABLE IF NOT EXISTS span_meta(
          scope TEXT NOT NULL,
          session TEXT NOT NULL,
          watermark INTEGER NOT NULL DEFAULT -1,
          PRIMARY KEY(scope, session));

        CREATE VIRTUAL TABLE IF NOT EXISTS span_fts USING fts5(text, scope UNINDEXED, session UNINDEXED, seq UNINDEXED);

        CREATE TABLE IF NOT EXISTS activation(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          node TEXT NOT NULL,
          query TEXT,
          at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS activation_scope ON activation(scope, at);

        -- Entity index (2.1). A node mentions the identifiers, packages and symbols it talks
        -- about; two nodes that never share a rare bigram still meet at the entity they share.
        -- Derived from claims, so it is rebuilt rather than migrated.
        CREATE TABLE IF NOT EXISTS mention(
          scope TEXT NOT NULL,
          node TEXT NOT NULL,
          entity TEXT NOT NULL,
          PRIMARY KEY(scope, node, entity));
        CREATE INDEX IF NOT EXISTS mention_entity ON mention(scope, entity);

        COMMIT;
      `)
      // v9: where a node came from (host session + event seq), how surprising it was when it
      // was written, and which turn wrote it; activations say what kind of use they record.
      const addColumn = (table, column, decl) => {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
        if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
      }
      addColumn('node', 'session', 'TEXT')
      addColumn('node', 'salience', 'REAL NOT NULL DEFAULT 0')
      addColumn('node', 'turn', 'INTEGER')
      addColumn('activation', 'source', 'TEXT')
      addColumn('activation', 'turn', 'INTEGER')
      // Version 1 databases predate the lesson column; CREATE TABLE IF NOT EXISTS cannot add
      // it, so migrate explicitly before declaring the schema current.
      const episodeColumns = this.db.prepare('PRAGMA table_info(episode)').all().map(c => c.name)
      if (!episodeColumns.includes('lesson')) this.db.exec('ALTER TABLE episode ADD COLUMN lesson TEXT')
      this.db.exec('CREATE INDEX IF NOT EXISTS episode_lesson ON episode(lesson)')
      this.tx(() => {
        if (version < 3) this.scrubObservationData()
        // v7: spans used to be stored verbatim. Redact them in place rather than dropping the
        // table, because spans from earlier sessions cannot be re-ingested.
        if (version < 8) {
          this.scrubSpans()
          const update = this.db.prepare('UPDATE node SET claim=?, terms=? WHERE id=?')
          for (const row of this.db.prepare('SELECT id, claim FROM node').all()) {
            const claim = redactText(row.claim)
            if (claim !== row.claim) update.run(claim, JSON.stringify(termSet(claim)), row.id)
          }
        }
        // v9: node terms used to stop at 80, which cut the tail off long Chinese claims; the
        // entity index is new. Both are derived from the claim, so recompute them once.
        if (version > 0 && version < 9) {
          const update = this.db.prepare('UPDATE node SET terms=? WHERE id=?')
          const rows = this.db.prepare('SELECT id, scope, claim FROM node').all()
          for (const row of rows) update.run(JSON.stringify(termSet(row.claim, NODE_TERMS)), row.id)
          this.indexMentions(rows)
        }
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      })
      if (version < 8) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() { try { this.db.close() } catch { /* already closed */ } }

  /** One-time cleanup of pre-v3 observation metadata; never rewrite harness blobs. */
  scrubObservationData() {
    for (const row of this.db.prepare('SELECT * FROM lesson').all()) {
      const task = row.task === null ? null : redact(row.task)
      // Old tokens have lost credential context. Rebuild from safe text, or drop them.
      const fields = ['summary', 'detail', 'success', 'divergence', 'trajectory', 'last_reason']
      this.db.prepare(`UPDATE lesson SET task=?, terms=?, ${fields.map(k => `${k}=?`).join(',')} WHERE id=?`)
        .run(task, JSON.stringify(termSet(task ?? '')), ...fields.map(k => row[k] === null ? null : redactText(row[k])), row.id)
    }
    for (const row of this.db.prepare("SELECT * FROM meta WHERE key LIKE 'last:%' OR key LIKE 'observations:%'").all()) {
      let value = parseJson(row.value, null)
      if (value === null) value = row.key.startsWith('observations:') ? [] : {}
      value = redactData(value)
      if (row.key.startsWith('observations:') && Array.isArray(value)) value = value.map(item => ({ ...item, terms: [] }))
      this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(value), row.key)
    }
    for (const row of this.db.prepare('SELECT rev,baseline FROM watch').all()) {
      const value = redactData(parseJson(row.baseline, {}))
      value.taskTerms = []
      this.db.prepare('UPDATE watch SET baseline=? WHERE rev=?').run(JSON.stringify(value), row.rev)
    }
    for (const row of this.db.prepare('SELECT id,divergence FROM episode WHERE divergence IS NOT NULL').all()) {
      this.db.prepare('UPDATE episode SET divergence=? WHERE id=?').run(redactText(row.divergence), row.id)
    }
    for (const row of this.db.prepare('SELECT id,detail,gate FROM ledger').all()) {
      this.db.prepare('UPDATE ledger SET detail=?,gate=? WHERE id=?')
        .run(row.detail === null ? null : redactText(row.detail), row.gate === null ? null : redactText(row.gate), row.id)
    }
  }

  /** One-time redaction of spans written before v7. Only rows that actually change are rewritten. */
  scrubSpans() {
    const update = this.db.prepare('UPDATE span SET text=?, bytes=? WHERE id=?')
    const reindex = this.db.prepare('UPDATE span_fts SET text=? WHERE rowid=?')
    for (const row of this.db.prepare('SELECT id, text FROM span').all()) {
      const text = redact(row.text)
      if (text === row.text) continue
      // The hash column stays as written: it only de-duplicates, and rehashing could collide
      // two spans that differed only in a secret.
      update.run(text, Buffer.byteLength(text), row.id)
      reindex.run(segment(text), row.id)
    }
  }

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

  readMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null
  }

  writeMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(key, String(value))
  }

  /** Newest node of one kind, used to carry a session's last known position forward. */
  latestNode(scope, kind) {
    return this.parseNode(this.db.prepare(
      'SELECT * FROM node WHERE scope=? AND kind=? ORDER BY seen DESC, rowid DESC LIMIT 1').get(scope, kind))
  }

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
    // Blobs deduplicate globally; revisions must retain project and lineage identity.
    // Identical default trees in two projects must never share a rev row/watch state.
    const key = hash(JSON.stringify({ scope, parent, canonical }))
    const existing = this.db.prepare('SELECT id,state FROM rev WHERE id=?').get(key)
    if (existing) {
      if (existing.state === 'retired' && state !== 'retired') throw Object.assign(new Error('此版本已被回滚，不能自动重新激活'), {code:'retired_revision'})
      return key
    }
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

  createEpisode({ scope, taskKey, trigger, fromRev, divergence = null, target = null, lesson = null }) {
    const key = id()
    this.db.prepare('INSERT INTO episode(id,scope,task_key,trigger,from_rev,state,created) VALUES (?,?,?,?,?,?,?)')
      .run(key, scope, taskKey, trigger, fromRev, 'running', this.now())
    if (divergence) this.db.prepare('UPDATE episode SET divergence=? WHERE id=?').run(JSON.stringify(redactData(divergence)), key)
    if (target) this.db.prepare('UPDATE episode SET target=? WHERE id=?').run(target, key)
    if (lesson) this.db.prepare('UPDATE episode SET lesson=? WHERE id=?').run(lesson, key)
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
    return this.db.prepare('SELECT id,scope,task_key,trigger,target,lesson,state,reason,created,finished FROM episode WHERE scope=? ORDER BY created DESC, rowid DESC LIMIT ?')
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
    const body = bounded(redactText(text), 24000)
    const path = `${kind}-${key}.txt`
    this.db.prepare('INSERT INTO evidence(id,episode,kind,path,bytes,created) VALUES (?,?,?,?,?,?)')
      .run(key, episode, kind, path, Buffer.byteLength(body), this.now())
    this.evidenceBody = this.evidenceBody ?? new Map()
    this.evidenceBody.set(key, body)
    this.db.prepare('INSERT OR REPLACE INTO blob VALUES (?,?,?,?)').run(`ev:${key}`, body, Buffer.byteLength(body), this.now())
    return { id: key, kind, path, bytes: Buffer.byteLength(body) }
  }

  readEvidence(key) { return this.get(`ev:${key}`) }

  // -- lessons -------------------------------------------------------------

  parseLesson(row) {
    return row ? {
      ...row,
      terms: parseJson(row.terms, []),
      detail: parseJson(row.detail, null),
      success: parseJson(row.success, null),
      divergence: parseJson(row.divergence, null),
    } : null
  }

  lesson(key) {
    return this.parseLesson(this.db.prepare('SELECT * FROM lesson WHERE id=?').get(key))
  }

  /**
   * Record one observed pattern. Matching is by kind plus task-term overlap, so a rephrased
   * request increments the same cluster instead of creating a new one. This is free: no model
   * call, no prompt injection, and the trajectory body is bounded before it is stored.
   */
  recordLesson({ scope, kind, taskKey, terms, task = null, summary, detail = null, success = null,
    divergence = null, trajectory = null }) {
    if (!scope || !kind || !taskKey) throw new Error('lesson 需要 scope/kind/taskKey')
    const now = this.now()
    const taskTerms = task != null ? termSet(task) : []
    const rows = this.db.prepare("SELECT * FROM lesson WHERE scope=? AND kind=? ORDER BY CASE state WHEN 'retired' THEN 0 WHEN 'compiled' THEN 1 ELSE 2 END, seen DESC")
      .all(scope, kind)
    const match = rows.find(row => sameTask(
      { taskKey: row.task_key, terms: parseJson(row.terms, []) },
      { taskKey, terms: taskTerms },
    ))
    const label = bounded(redact(String(task ?? '')), 600)
    const text = bounded(redact(String(summary ?? kind)), 600)
    if (match) {
      // Recurrence adds support but never reopens the lesson by itself. A compiled lesson is
      // already in the current version; a retired one has failed its paired gate twice. Only
      // an explicit rollback reverses a compiled lesson, otherwise retirement would mean
      // nothing and a pattern that fails validation forever would keep buying episodes.
      this.db.prepare(`UPDATE lesson SET
        support=support+1, seen=?, task=COALESCE(?,task), summary=?, detail=COALESCE(?,detail),
        success=COALESCE(?,success), divergence=COALESCE(?,divergence), trajectory=COALESCE(?,trajectory)
        WHERE id=?`)
        .run(now, label, text, jsonText(detail), jsonText(success), jsonText(divergence),
          trajectory === null ? null : bounded(redactText(String(trajectory)), 8000), match.id)
      return this.lesson(match.id)
    }
    const key = id()
    this.db.prepare(`INSERT INTO lesson(
      id,scope,kind,terms,task_key,task,summary,detail,success,divergence,trajectory,
      support,contradictions,attempts,state,episode,rev,last_reason,last_attempt,created,seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key, scope, kind, JSON.stringify(taskTerms), taskKey, label, text,
        jsonText(detail), jsonText(success), jsonText(divergence),
        trajectory === null ? null : bounded(redactText(String(trajectory)), 8000),
        1, 0, 0, 'observed', null, null, null, null, now, now)
    this.pruneLessons(scope)
    return this.lesson(key)
  }

  /** Support threshold reached: visible as a candidate, still not a version or a prompt. */
  markLessonCandidate(key) {
    this.db.prepare("UPDATE lesson SET state='candidate' WHERE id=? AND state='observed'").run(key)
    return this.lesson(key)
  }

  pruneLessons(scope, limit = 200) {
    this.db.prepare(`DELETE FROM lesson WHERE scope=? AND state IN ('observed','candidate')
      AND id NOT IN (SELECT id FROM lesson WHERE scope=? AND state IN ('observed','candidate')
      ORDER BY seen DESC LIMIT ?)`).run(scope, scope, limit)
  }

  lessons(scope, { state = null, limit = 20 } = {}) {
    const rows = state
      ? this.db.prepare('SELECT * FROM lesson WHERE scope=? AND state=? ORDER BY seen DESC LIMIT ?').all(scope, state, limit)
      : this.db.prepare('SELECT * FROM lesson WHERE scope=? ORDER BY seen DESC LIMIT ?').all(scope, limit)
    return rows.map(row => this.parseLesson(row))
  }

  /** All matching trigger clusters, including durable retirement/compilation records. */
  matchingLessons(scope, reference, kinds) {
    const slots = kinds.map(() => '?').join(',')
    // No state/recency limit: retirement also applies to direct session runs.
    return this.db.prepare(`SELECT * FROM lesson WHERE scope=? AND kind IN (${slots}) ORDER BY seen DESC`)
      .all(scope, ...kinds).map(row => this.parseLesson(row))
      .filter(row => sameTask({ taskKey: row.task_key, terms: row.terms }, reference))
  }

  /** Supported clusters that may justify a paid compilation episode. */
  lessonCandidates(scope, threshold, { kinds = ['user_correction', 'tool_error', 'incomplete', 'recovery'], limit = 10, windowMs = null } = {}) {
    const slots = kinds.map(() => '?').join(',')
    // A stale cluster is not a recurring pattern. The window is optional so callers/tests can
    // inspect the whole pool, but the paid path only sees what was observed recently.
    const cutoff = windowMs === null ? 0 : this.now() - windowMs
    return this.db.prepare(`SELECT * FROM lesson
      WHERE scope=? AND state IN ('observed','candidate') AND kind IN (${slots})
        AND support>=? AND contradictions<2 AND seen>=?
      ORDER BY support DESC, seen DESC LIMIT ?`)
      .all(scope, ...kinds, threshold, cutoff, limit)
      .map(row => this.parseLesson(row))
  }

  /** Latest successful sample for the same task family, used as contrast evidence. */
  relatedLesson(scope, { taskKey, terms = [], kinds = ['resolved', 'recovery', 'verified_success'], limit = 100 } = {}) {
    const slots = kinds.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT * FROM lesson
      WHERE scope=? AND state!='retired' AND kind IN (${slots})
      ORDER BY seen DESC LIMIT ?`).all(scope, ...kinds, limit)
    for (const row of rows) {
      const lesson = this.parseLesson(row)
      if (sameTask({ taskKey: lesson.task_key, terms: lesson.terms }, { taskKey, terms })) return lesson
    }
    return null
  }

  /** Link an episode outcome back to its lesson. Rejections retire a cluster after two tries. */
  settleLesson(key, { state, rev = null, episode = null, reason = null }) {
    const row = this.db.prepare('SELECT * FROM lesson WHERE id=?').get(key)
    if (!row) return null
    const now = this.now()
    const attempts = row.attempts + 1
    const note = bounded(redact(String(reason ?? '')), 300)
    if (state === 'shadow') {
      this.db.prepare(`UPDATE lesson SET state='compiled', rev=?, episode=?, attempts=?, last_reason=?,
        last_attempt=?, seen=? WHERE id=?`).run(rev, episode, attempts, note, now, now, key)
    } else if (state === 'rejected') {
      const contradictions = row.contradictions + 1
      this.db.prepare(`UPDATE lesson SET state=?, rev=NULL, episode=?, contradictions=?, attempts=?,
        last_reason=?, last_attempt=?, seen=? WHERE id=?`)
        .run(contradictions >= 2 ? 'retired' : 'observed', episode, contradictions, attempts, note, now, now, key)
    } else {
      // Provider failure/interruption is not evidence against the experience; keep its status
      // (compiled/candidate/observed) but record the attempt so the next run can explain it.
      const keep = row.state === 'compiled' ? 'compiled' : row.state === 'candidate' ? 'candidate' : 'observed'
      this.db.prepare(`UPDATE lesson SET state=?, attempts=?, last_reason=?, last_attempt=?, seen=? WHERE id=?`)
        .run(keep, attempts, note, now, now, key)
    }
    return this.lesson(key)
  }

  /** A rolled-back revision invalidates the lessons it compiled. */
  reopenLessonsForRev(rev, scope) {
    const rows = this.db.prepare('SELECT id,contradictions FROM lesson WHERE rev=? AND scope=?').all(rev, scope)
    const now = this.now()
    for (const row of rows) {
      const contradictions = row.contradictions + 1
      this.db.prepare(`UPDATE lesson SET state=?, rev=NULL, contradictions=?, last_reason='revision_rolled_back',
        seen=? WHERE id=?`).run(contradictions >= 2 ? 'retired' : 'observed', contradictions, now, row.id)
    }
    return rows.length
  }

  lessonStats(scope) {
    const counts = { observed: 0, candidate: 0, compiled: 0, retired: 0 }
    for (const row of this.db.prepare('SELECT state, COUNT(*) n FROM lesson WHERE scope=? GROUP BY state').all(scope)) {
      counts[row.state] = row.n
    }
    const top = this.db.prepare(`SELECT id,kind,summary,support,contradictions,state,last_reason,seen
      FROM lesson WHERE scope=? AND state IN ('observed','candidate')
      ORDER BY support DESC, seen DESC LIMIT 5`).all(scope)
    return { counts, top }
  }

  callStatsForScope(scope) {
    return this.db.prepare(`SELECT c.phase, c.outcome, COUNT(*) n, COALESCE(SUM(c.input_bytes),0) bytes
      FROM call c JOIN episode e ON e.id=c.episode WHERE e.scope=?
      GROUP BY c.phase, c.outcome`).all(scope)
  }

  // -- memory skeleton -----------------------------------------------------

  /**
   * Persist extracted nodes and edges. Repeating the same node only raises its support:
   * recurrence is evidence, but it must never create a second copy of the same claim.
   */
  recordNodes(scope, { nodes = [], edges = [] } = {}) {
    if (!scope || (!nodes.length && !edges.length)) return 0
    const now = this.now()
    this.tx(() => {
      // A rewritten artifact keeps its newest fingerprint: the stored hash is what later proves
      // the evidence stale, so keeping the first one would flag every rewrite as stale.
      const insert = this.db.prepare(`INSERT INTO node(
        id,scope,kind,claim,terms,anchor,hash,source,seq,pin,valid_from,valid_to,recorded_at,
        weight,support,hits,state,created,seen,session,salience,turn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET support=support+1, seen=excluded.seen, claim=excluded.claim,
          hash=COALESCE(excluded.hash, hash), salience=MAX(salience, excluded.salience)`)
      const written = []
      for (const node of nodes) {
        const claim = bounded(redactText(String(node.claim ?? '')), 400)
        insert.run(node.id, scope, String(node.kind), claim, JSON.stringify(termSet(claim, NODE_TERMS)),
          node.anchor ?? null, node.hash ?? null, node.source ?? null, Number.isFinite(Number(node.seq)) ? Number(node.seq) : 0,
          node.pin ? 1 : 0, now, null, now, 1, 1, 0, 'active', now, now,
          node.session ?? null, Number(node.salience) || 0, Number.isInteger(node.turn) ? node.turn : null)
        written.push({ id: node.id, scope, claim })
      }
      this.indexMentions(written)
      const link = this.db.prepare('INSERT OR IGNORE INTO edge(id,scope,src,dst,rel,w,created) VALUES (?,?,?,?,?,?,?)')
      for (const edge of edges) {
        if (!edge?.src || !edge?.dst) continue
        link.run(hash(`${scope}\u0000${edge.src}\u0000${edge.dst}\u0000${edge.rel}`),
          scope, edge.src, edge.dst, String(edge.rel), Number(edge.w) || 1, now)
      }
      this.pruneNodes(scope, this.maxNodes)
    })
    return nodes.length
  }

  /** Rebuild the entity rows of the given nodes from their claims. */
  indexMentions(rows) {
    const clear = this.db.prepare('DELETE FROM mention WHERE scope=? AND node=?')
    const add = this.db.prepare('INSERT OR IGNORE INTO mention(scope,node,entity) VALUES (?,?,?)')
    for (const row of rows) {
      clear.run(row.scope, row.id)
      for (const entity of entities(row.claim)) add.run(row.scope, row.id, entity)
    }
  }

  /** node id -> entities, for the nodes of one scope. */
  mentions(scope) {
    const out = new Map()
    for (const row of this.db.prepare('SELECT node, entity FROM mention WHERE scope=?').all(scope)) {
      const list = out.get(row.node)
      if (list) list.push(row.entity)
      else out.set(row.node, [row.entity])
    }
    return out
  }

  /** Live nodes that mention any of the given entities. */
  nodesMentioning(scope, list) {
    const wanted = [...new Set(list ?? [])]
    if (!wanted.length) return []
    const slots = wanted.map(() => '?').join(',')
    return this.db.prepare(`SELECT DISTINCT m.node id, m.entity FROM mention m JOIN node n ON n.id=m.node
      WHERE m.scope=? AND m.entity IN (${slots}) AND n.state='active' AND n.valid_to IS NULL`).all(scope, ...wanted)
  }

  /**
   * Keep the graph bounded, and prefer to let go of what was already let go of.
   *
   * The old rule kept the newest 500 by `seen` and deleted the rest, which is a recency policy
   * wearing a capacity policy's clothes: a decision that had been reused for weeks lost to a
   * progress line written thirty seconds ago. Deleting on age is the one thing this project
   * says it does not do.
   *
   * Two stages, and the order is the point:
   *   1. retired rows are kept — retirement is a visibility change, and recall still reads them —
   *      until the scope holds four times the cap in total. Only then do the oldest retired rows
   *      go, because a table that cannot shrink is an operational bug.
   *   2. if the live set is over the cap, fall back to the old recency rule, but never touch a
   *      pinned node, and rank retrieved nodes ahead of equally old ones.
   *
   * The second stage keeps the table bounded even on a project that never calls `/mem sleep`.
   */
  pruneNodes(scope, limit = this.maxNodes) {
    const total = this.db.prepare('SELECT COUNT(*) n FROM node WHERE scope=?').get(scope)?.n ?? 0
    if (total > limit * 4) {
      this.db.prepare(`DELETE FROM node WHERE scope=? AND pin=0 AND state!='active' AND id IN (
        SELECT id FROM node WHERE scope=? AND pin=0 AND state!='active' ORDER BY seen ASC LIMIT ?)`)
        .run(scope, scope, total - limit * 4)
    }
    // Stage 2: still over the cap. Oldest-first ranking, but retrieved nodes rank ahead of
    // equally old ones — the cap is still enforced, because a table that cannot shrink is an
    // operational bug, not a fairness win. Exempting `hits > 0` entirely (the first attempt)
    // did exactly that: 30 nodes with a cap of 5 kept 10.
    const active = this.db.prepare(
      "SELECT COUNT(*) n FROM node WHERE scope=? AND pin=0 AND state='active'").get(scope)?.n ?? 0
    if (active > limit) {
      this.db.prepare(`DELETE FROM node WHERE scope=? AND pin=0 AND state='active' AND id NOT IN (
        SELECT id FROM node WHERE scope=? AND pin=0 AND state='active'
        ORDER BY hits DESC, seen DESC LIMIT ?)`).run(scope, scope, limit)
    }
    this.db.prepare(`DELETE FROM edge WHERE scope=? AND (
      src NOT IN (SELECT id FROM node WHERE scope=?) OR dst NOT IN (SELECT id FROM node WHERE scope=?))`)
      .run(scope, scope, scope)
    this.db.prepare('DELETE FROM mention WHERE scope=? AND node NOT IN (SELECT id FROM node WHERE scope=?)')
      .run(scope, scope)
  }

  parseNode(row) {
    return row ? { ...row, terms: parseJson(row.terms, []) } : null
  }

  /**
   * Live nodes, pinned first then most recently seen. The default window is the configured cap:
   * a narrower window made the oldest fifth of the graph invisible to every lexical lookup.
   */
  activeNodes(scope, limit = this.maxNodes, { includeSuperseded = false, includeRetired = false } = {}) {
    return this.db.prepare(`SELECT * FROM node WHERE scope=? AND ${includeRetired ? "state IN ('active','retired','stale')" : "state='active'"}
      ${includeSuperseded ? '' : 'AND valid_to IS NULL'}
      ORDER BY pin DESC, seen DESC LIMIT ?`).all(scope, limit).map(row => this.parseNode(row))
  }

  /** Close a node's validity interval. The row stays; only its claim on the present ends. */
  supersede(nodeId, at = this.now()) {
    return this.db.prepare('UPDATE node SET valid_to=?, seen=? WHERE id=? AND valid_to IS NULL')
      .run(at, at, nodeId).changes ?? 0
  }

  nodeRow(id) {
    return this.parseNode(this.db.prepare('SELECT * FROM node WHERE id=?').get(id))
  }

  /**
   * Term-overlap lookup. Deliberately lexical: an embedding would need a model at write time
   * and would make every recall unauditable.
   */
  searchNodes(scope, queryTerms, limit = 12, { includeSuperseded = false, includeRetired = false } = {}) {
    const wanted = new Set(queryTerms ?? [])
    if (!wanted.size) return []
    return this.activeNodes(scope, this.maxNodes * 4, { includeSuperseded, includeRetired })
      .map(node => {
        const own = new Set(node.terms)
        let shared = 0
        for (const term of wanted) if (own.has(term)) shared++
        return { node, score: shared / Math.max(1, own.size + wanted.size - shared) }
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.node.seen - a.node.seen)
      .slice(0, limit)
      .map(entry => entry.node)
  }

  /**
   * One hop out from the given nodes, in either direction. `associative` skips `supersedes`:
   * a replaced claim is history, not a neighbour, and following it let recall wire obsolete
   * claims back into the live graph.
   */
  neighbours(scope, ids, { associative = false } = {}) {
    if (!ids.length) return []
    const slots = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT * FROM edge WHERE scope=? AND (src IN (${slots}) OR dst IN (${slots}))
      ${associative ? "AND rel!='supersedes'" : ''}`)
      .all(scope, ...ids, ...ids)
    const other = new Set()
    for (const row of rows) other.add(ids.includes(row.src) ? row.dst : row.src)
    return [...other]
      .filter(id => !ids.includes(id))
      .map(id => this.nodeRow(id))
      .filter(Boolean)
  }

  /**
   * Record that a node was used. `source` says how: `recall` (the tool), `cue` (the user named
   * it), `tool` (a tool touched its path), `answer` (the model's reply referred to it). The log
   * is the base-level activation, the Hebbian signal and the GC evidence at once.
   */
  activate(scope, { node, query = null, source = 'recall', turn = null }) {
    this.db.prepare('INSERT INTO activation(id,scope,node,query,at,source,turn) VALUES (?,?,?,?,?,?,?)')
      .run(id(), scope, node, query, this.now(), source, Number.isInteger(turn) ? turn : null)
    this.db.prepare('UPDATE node SET hits=hits+1, weight=MIN(3.0, weight+0.1), seen=? WHERE id=?').run(this.now(), node)
    this.pruneActivations(scope)
  }

  /**
   * Bound the activation log. Rows for deleted nodes go first — they can no longer move any
   * score — then the oldest rows past the cap, which contribute least to a power-law sum.
   */
  pruneActivations(scope, limit = MAX_ACTIVATIONS_PER_SCOPE) {
    const n = this.db.prepare('SELECT COUNT(*) n FROM activation WHERE scope=?').get(scope)?.n ?? 0
    if (n <= limit) return 0
    let removed = this.db.prepare('DELETE FROM activation WHERE scope=? AND node NOT IN (SELECT id FROM node WHERE scope=?)')
      .run(scope, scope).changes ?? 0
    if (n - removed > limit) {
      removed += this.db.prepare(`DELETE FROM activation WHERE scope=? AND rowid NOT IN (
        SELECT rowid FROM activation WHERE scope=? ORDER BY at DESC, rowid DESC LIMIT ?)`).run(scope, scope, limit).changes ?? 0
    }
    return removed
  }

  /** Evidence invalidated by a later state change: withheld from every projection. */
  markStale(nodeId, reason = null) {
    this.db.prepare("UPDATE node SET state='stale', valid_to=?, seen=? WHERE id=?").run(this.now(), this.now(), nodeId)
    return reason
  }

  memoryStats(scope) {
    const byKind = Object.fromEntries(this.db.prepare(
      "SELECT kind, COUNT(*) n FROM node WHERE scope=? AND state='active' GROUP BY kind").all(scope)
      .map(row => [row.kind, row.n]))
    const byState = Object.fromEntries(this.db.prepare(
      'SELECT state, COUNT(*) n FROM node WHERE scope=? GROUP BY state').all(scope)
      .map(row => [row.state, row.n]))
    const edges = this.db.prepare('SELECT COUNT(*) n FROM edge WHERE scope=?').get(scope)?.n ?? 0
    const bytes = this.db.prepare("SELECT COALESCE(SUM(LENGTH(claim)),0) b FROM node WHERE scope=? AND state='active'")
      .get(scope)?.b ?? 0
    const pinned = this.db.prepare("SELECT COUNT(*) n FROM node WHERE scope=? AND pin=1 AND state='active'")
      .get(scope)?.n ?? 0
    const hits = this.db.prepare('SELECT COUNT(*) n FROM activation WHERE scope=?').get(scope)?.n ?? 0
    return { byKind, byState, edges, bytes, pinned, activations: hits }
  }

  // -- knowledge graph -----------------------------------------------------

  /**
   * Upsert one typed edge, accumulating weight.
   *
   * Weight is the point: an edge that keeps firing gets stronger, one that never does decays
   * away. That is the only mechanism here that makes the graph learn instead of merely record.
   */
  link(scope, { src, dst, rel, delta = 0.1, cap = 5, mode = 'add' }) {
    if (!scope || !src || !dst || src === dst) return null
    const id = hash(`${scope}\u0000${src}\u0000${dst}\u0000${rel}`)
    const existing = this.db.prepare('SELECT w FROM edge WHERE id=?').get(id)
    if (existing) {
      // Usage accumulates; similarity is a property and only ever takes its best value.
      if (mode === 'max') this.db.prepare('UPDATE edge SET w=MAX(w, MIN(?, ?)) WHERE id=?').run(cap, delta, id)
      else this.db.prepare('UPDATE edge SET w=MIN(?, w+?) WHERE id=?').run(cap, delta, id)
    }
    else {
      this.db.prepare('INSERT INTO edge(id,scope,src,dst,rel,w,created) VALUES (?,?,?,?,?,?,?)')
        .run(id, scope, src, dst, String(rel), Math.min(cap, delta), this.now())
    }
    return id
  }

  /** Every edge touching a node, strongest first. */
  edgesOf(scope, id) {
    return this.db.prepare('SELECT * FROM edge WHERE scope=? AND (src=? OR dst=?) ORDER BY w DESC')
      .all(scope, id, id)
  }

  /** Decay every edge and drop what has faded below noise. Returns how many were removed. */
  decayEdges(scope, { factor = 0.97, floor = 0.05, rels = null } = {}) {
    const only = rels?.length ? ` AND rel IN (${rels.map(() => '?').join(',')})` : ''
    const args = rels?.length ? rels : []
    this.db.prepare(`UPDATE edge SET w=w*? WHERE scope=?${only}`).run(factor, scope, ...args)
    return this.db.prepare(`DELETE FROM edge WHERE scope=? AND w < ?${only}`).run(scope, floor, ...args).changes ?? 0
  }

  /**
   * Homeostatic scaling: no node may hold more than `budget` of learned weight in total.
   *
   * A global decay keeps every ratio, so a hub that is reinforced on every recall stays a hub
   * forever. Scaling per node (Turrigiano's synaptic scaling, in its simplest form) caps what
   * any one memory can pull towards itself while leaving the ranking among its own edges alone.
   * Each edge takes the stricter factor of its two endpoints, so the result is symmetric.
   */
  scaleEdges(scope, { rels = ['coactivated', 'precedes'], budget = 3 } = {}) {
    const slots = rels.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT id, src, dst, w FROM edge WHERE scope=? AND rel IN (${slots})`).all(scope, ...rels)
    const load = new Map()
    for (const row of rows) {
      load.set(row.src, (load.get(row.src) ?? 0) + row.w)
      load.set(row.dst, (load.get(row.dst) ?? 0) + row.w)
    }
    const factor = node => Math.min(1, budget / Math.max(load.get(node) ?? 0, 1e-9))
    const update = this.db.prepare('UPDATE edge SET w=? WHERE id=?')
    let scaled = 0
    for (const row of rows) {
      const f = Math.min(factor(row.src), factor(row.dst))
      if (f < 1) { update.run(row.w * f, row.id); scaled++ }
    }
    return scaled
  }

  /** Every edge weight in a scope, with its relation, for callers that score by connectivity. */
  edgeWeights(scope) {
    return this.db.prepare('SELECT src, dst, rel, w FROM edge WHERE scope=?').all(scope)
  }

  graphStats(scope) {
    const byRel = Object.fromEntries(this.db.prepare(
      'SELECT rel, COUNT(*) n, ROUND(AVG(w),2) avg FROM edge WHERE scope=? GROUP BY rel').all(scope)
      .map(row => [row.rel, { n: row.n, avg: row.avg }]))
    const hubs = this.db.prepare(`SELECT n.id, n.kind, n.claim, COUNT(e.id) degree, ROUND(MAX(e.w),2) peak
      FROM node n JOIN edge e ON (e.src = n.id OR e.dst = n.id)
      WHERE n.scope=? GROUP BY n.id ORDER BY degree DESC, peak DESC LIMIT 5`).all(scope)
    return { edges: this.db.prepare('SELECT COUNT(*) n FROM edge WHERE scope=?').get(scope)?.n ?? 0, byRel, hubs }
  }

  // -- span index ----------------------------------------------------------

  /**
   * Store addressable spans, skipping duplicates by content hash.
   *
   * De-duplication is not an optimisation here: a long session repeats the same tool output
   * and the same error dozens of times, and without it those copies crowd the top of every
   * result list while the rest of the history stays invisible.
   */
  putSpans(scope, session, rows) {
    if (!rows?.length) return 0
    let added = 0
    this.tx(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO span(scope,session,seq,kind,hash,text,bytes) VALUES (?,?,?,?,?,?,?)')
      const index = this.db.prepare('INSERT INTO span_fts(rowid, text, scope, session, seq) VALUES (?,?,?,?,?)')
      for (const row of rows) {
        const result = insert.run(scope, session, row.seq, String(row.kind ?? ''), row.hash, row.text, Buffer.byteLength(row.text))
        if (!result.changes) continue
        // rowid ties the FTS row to the span row, so a result can carry its session and seq
        // without a second lookup — and without the seq collision two sessions would cause.
        index.run(Number(result.lastInsertRowid), row.indexText ?? row.text, scope, session, row.seq)
        added++
      }
      if (added) this.pruneSpans(scope)
    })
    return added
  }

  /**
   * Keep the span index bounded per project. Oldest rows go first (id is insertion order);
   * watermarks are left alone, so a pruned span is gone for good rather than re-ingested.
   */
  pruneSpans(scope, limit = MAX_SPANS_PER_SCOPE) {
    const n = this.db.prepare('SELECT COUNT(*) n FROM span WHERE scope=?').get(scope)?.n ?? 0
    if (n <= limit) return 0
    const cutoff = this.db.prepare('SELECT id FROM span WHERE scope=? ORDER BY id DESC LIMIT 1 OFFSET ?').get(scope, limit)?.id
    if (cutoff === undefined) return 0
    this.db.prepare('DELETE FROM span_fts WHERE rowid IN (SELECT id FROM span WHERE scope=? AND id<=?)').run(scope, cutoff)
    return this.db.prepare('DELETE FROM span WHERE scope=? AND id<=?').run(scope, cutoff).changes ?? 0
  }

  spanWatermark(scope, session) {
    return this.db.prepare('SELECT watermark FROM span_meta WHERE scope=? AND session=?').get(scope, session)?.watermark ?? -1
  }

  setSpanWatermark(scope, session, seq) {
    this.db.prepare(`INSERT INTO span_meta(scope,session,watermark) VALUES (?,?,?)
      ON CONFLICT(scope,session) DO UPDATE SET watermark=MAX(watermark, excluded.watermark)`).run(scope, session, seq)
  }

  spanCoverage(scope) {
    const row = this.db.prepare('SELECT COUNT(*) n, MIN(seq) a, MAX(seq) b, COUNT(DISTINCT session) s FROM span WHERE scope=?').get(scope)
    return { spans: row?.n ?? 0, from: row?.a ?? null, to: row?.b ?? null, sessions: row?.s ?? 0 }
  }

  /** Full-text search over stored spans. bm25 is lower-is-better. */
  searchSpans(scope, match, limit) {
    return this.db.prepare(`SELECT s.seq, s.session, s.text, bm25(span_fts) score
      FROM span_fts JOIN span s ON s.id = span_fts.rowid
      WHERE span_fts MATCH ? AND span_fts.scope=?
      ORDER BY score LIMIT ?`).all(match, scope, limit)
  }

  /** The verbatim span a node was extracted from — the index half of a hippocampal index. */
  spanAt(scope, session, seq) {
    if (!session || !Number.isInteger(seq) || seq < 0) return null
    return this.db.prepare('SELECT seq, session, text FROM span WHERE scope=? AND session=? AND seq=?').get(scope, String(session), seq) ?? null
  }

  /** The other direction: live nodes extracted from one span. */
  nodesAt(scope, session, seq) {
    if (!session || !Number.isInteger(seq) || seq < 0) return []
    return this.db.prepare("SELECT * FROM node WHERE scope=? AND session=? AND seq=? AND state='active' AND valid_to IS NULL")
      .all(scope, String(session), seq).map(row => this.parseNode(row))
  }

  /** Substring fallback for queries the tokenizer cannot express (paths, mixed scripts). */
  findSpans(scope, needle, limit) {
    return this.db.prepare('SELECT seq, session, text FROM span WHERE scope=? AND text LIKE ? ORDER BY seq LIMIT ?')
      .all(scope, `%${String(needle).replaceAll('%', '')}%`, limit)
  }

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
      .run(key, rev, scope, action, actor, gate ? JSON.stringify(redactData(gate)) : null,
        detail === null ? null : bounded(typeof detail === 'string' ? redactText(detail) : JSON.stringify(redactData(detail)), 4000), this.now())
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
      for (const [key, { limit, amount, lifetime = false }] of Object.entries(dims)) {
        const row = this.db.prepare('SELECT * FROM budget WHERE key=?').get(key)
        const used = row && (lifetime || row.day === dayKey) ? row.used : 0
        if (used + amount > limit) return { ok: false, key, used, limit, amount }
      }
      // Capacity is spent immediately, not held: this plugin never retries paid work, so
      // there is no window in which a reservation should be released.
      for (const [key, { amount, lifetime = false }] of Object.entries(dims)) {
        this.db.prepare(`INSERT INTO budget(key,day,used,reserved) VALUES (?,?,?,0)
          ON CONFLICT(key) DO UPDATE SET
            used=CASE WHEN ? OR budget.day=excluded.day THEN budget.used+excluded.used ELSE excluded.used END,
            reserved=0, day=excluded.day`)
          .run(key, lifetime ? '*' : dayKey, amount, lifetime ? 1 : 0)
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

  budgetState(dayKey, keys, lifetimeKeys = []) {
    const out = {}
    for (const key of keys) {
      const row = this.db.prepare('SELECT * FROM budget WHERE key=?').get(key)
      out[key] = row && (lifetimeKeys.includes(key) || row.day === dayKey) ? { used: row.used, reserved: row.reserved } : { used: 0, reserved: 0 }
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
