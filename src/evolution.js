import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { bounded, clean, day, hash, id, integer, redact } from './util.js'
import { skillText } from './learner.js'
import { suiteContract, executeProbe, fail, object } from './evolution-suite.js'
import { EDITOR_SYSTEM } from './evolution-model.js'
import { prepareDocker, executeJavaScript } from './evolution-docker.js'

export function evolutionSettings(input) {
  if (input.evolution !== undefined && typeof input.evolution !== 'boolean') throw new Error('evolution 必须是布尔值')
  const c = {
    enabled: input.evolution ?? false, provider: input.evolutionProvider ?? '',
    model: input.evolutionModel ?? '', editorModel: input.evolutionEditorModel ?? input.evolutionModel ?? '',
    reasoningEffort: input.evolutionReasoningEffort ?? '',
    rounds: integer(input.evolutionMaxRounds, 2, 1, 5), candidates: integer(input.evolutionCandidates, 2, 2, 4),
    concurrency: integer(input.evolutionConcurrency, 2, 1, 4), maxSteps: integer(input.evolutionMaxSteps, 6, 1, 20),
    maxCalls: integer(input.evolutionMaxCalls, 80, 8, 1000), dailyCalls: integer(input.evolutionDailyCalls, 100, 0, 4000),
    maxInputBytes: integer(input.evolutionMaxInputBytes, 24000, 4000, 96000),
    runInputBytes: integer(input.evolutionRunInputBytes, 512000, 8000, 96000000),
    dailyInputBytes: integer(input.evolutionDailyInputBytes, 1000000, 0, 384000000),
    maxTokens: integer(input.evolutionMaxTokens, 2400, 256, 8000), timeoutMs: integer(input.evolutionTimeoutMs, 180000, 100, 3600000),
    requestTimeoutMs: integer(input.evolutionRequestTimeoutMs, 60000, 50, 180000), cooldownMs: integer(input.evolutionCooldownMs, 3600000, 1000, 86400000),
    dockerImage: input.evolutionDockerImage ?? '', sandboxTimeoutMs: integer(input.evolutionSandboxTimeoutMs, 10000, 1000, 60000),
  }
  if (c.enabled && (!c.provider || !c.model || !c.editorModel)) throw new Error('进化需要明确配置 evolutionProvider/evolutionModel，不继承 learning 路由')
  return c
}

const strategyOf = value => {
  const text = skillText(value)
  if (Buffer.byteLength(text) > 2600) throw fail('invalid_strategy', '方法最多 2600 字节，为验证范围留出空间')
  return JSON.parse(text)
}
const score = rows => ({ passed: rows.filter(r => r.pass).length, total: rows.length,
  calls: rows.reduce((n, r) => n + r.calls, 0), actions: rows.reduce((n, r) => n + r.actions, 0),
  errors: rows.reduce((n, r) => n + r.toolErrors, 0), durationMs: rows.reduce((n, r) => n + r.durationMs, 0) })
export function better(a, b) {
  const x = score(a), y = score(b)
  if (a.some((r, i) => b[i]?.pass && !r.pass)) return false
  if (x.passed !== y.passed) return x.passed > y.passed
  // Timing is noisy. An efficiency-only win needs full correctness and fewer calls/actions
  // in at least two cases, with no case-level resource or error regression.
  return x.passed === x.total && a.every((r, i) => r.calls <= b[i].calls && r.actions <= b[i].actions && r.toolErrors <= b[i].toolErrors) &&
    a.filter((r, i) => r.calls < b[i].calls || r.actions < b[i].actions).length >= 2
}
const brief = rows => rows.map(({ trace, answer, ...r }) => ({ ...r, answer: bounded(redact(answer), 800),
  trace: trace.slice(-4).map(t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'string' ? bounded(redact(v), 600) : v]))) }))
const codes = new Set(['cancelled', 'timeout', 'request_timeout', 'provider_failure', 'invalid_json', 'invalid_strategy', 'invalid_contract', 'truncated', 'input_limit', 'input_budget', 'output_limit', 'run_budget', 'daily_budget', 'source_changed', 'invalid_lesson', 'sandbox_unavailable', 'sandbox_cleanup', 'sandbox_timeout', 'sandbox_output_limit', 'program_error', 'blocked_strategy', 'duplicate_strategy'])

export class Evolution {
  constructor(store, generate, config) {
    this.store = store; this.db = store.db; this.generate = generate; this.config = config
    this.owner = id(); this.running = null; this.closed = false; this.active = null
  }
  recover() {
    this.db.prepare("UPDATE evo_runs SET state='interrupted',reason='lease_expired',finished=? WHERE state='running' AND lease<?")
      .run(this.store.now(), this.store.now())
  }
  register(scope, input) {
    const contract = suiteContract(input)
    return this.store.tx(() => {
      this.recover()
      if (this.db.prepare("SELECT 1 FROM evo_runs WHERE scope=? AND suite=? AND state='running'").get(scope, contract.value.id)) throw fail('busy', '先停止正在进行的该套件进化')
      const old = this.db.prepare('SELECT * FROM evo_suites WHERE scope=? AND id=?').get(scope, contract.value.id)
      if (old?.hash === contract.hash) return { id: contract.value.id, unchanged: true }
      if (!old && this.db.prepare('SELECT COUNT(*) AS n FROM evo_suites WHERE scope=?').get(scope).n >= 20) throw fail('suite_limit')
      for (const v of this.db.prepare("SELECT memory FROM evo_versions WHERE scope=? AND suite=? AND state IN ('current','pending_review')").all(scope, contract.value.id)) this.retire(v.memory)
      this.db.prepare('INSERT INTO evo_suites VALUES (?,?,?,?,?,NULL) ON CONFLICT(scope,id) DO UPDATE SET contract=excluded.contract,hash=excluded.hash,created=excluded.created,last_started=NULL')
        .run(scope, contract.value.id, contract.text, contract.hash, this.store.now())
      return { id: contract.value.id, train: contract.value.cases.filter(c => c.split === 'train').length,
        validation: contract.value.cases.filter(c => c.split === 'validation').length, auto: false, ignoredLegacyAuto: contract.value.auto }
    })
  }
  retire(memory) {
    this.db.prepare("UPDATE memories SET status='deprecated',updated=? WHERE id=?").run(this.store.now(), memory)
    this.db.prepare("UPDATE evo_versions SET state='superseded' WHERE memory=?").run(memory)
    this.store.experience.invalidateMemory(memory)
  }
  list(scope) {
    return this.db.prepare('SELECT id,contract,last_started FROM evo_suites WHERE scope=? ORDER BY id').all(scope).map(r => {
      const c = JSON.parse(r.contract)
      return { id: r.id, title: c.title, keywords: c.keywords, runtime: c.runtime, auto: false, ignoredLegacyAuto: c.auto, cases: c.cases.length, lastStarted: r.last_started,
        current: this.current(scope, r.id)?.memory ?? null }
    })
  }
  current(scope, suite) {
    return this.db.prepare(`SELECT v.*,m.text,m.status FROM evo_versions v JOIN memories m ON m.id=v.memory
      WHERE v.scope=? AND v.suite=? AND v.state='current' AND m.status='active' ORDER BY v.created DESC,v.rowid DESC LIMIT 1`).get(scope, suite)
  }
  status(scope, run) {
    this.recover()
    const rows = run ? [this.db.prepare('SELECT * FROM evo_runs WHERE id=? AND scope=?').get(run, scope)].filter(Boolean) :
      this.db.prepare('SELECT * FROM evo_runs WHERE scope=? ORDER BY created DESC,rowid DESC LIMIT 5').all(scope)
    return rows.map(({ owner, ...r }) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null,
      calls: this.db.prepare('SELECT phase,outcome,COUNT(*) AS count FROM evo_calls WHERE run=? GROUP BY phase,outcome').all(r.id) }))
  }
  inspect(scope, run) {
    const status = this.status(scope, run)[0]
    if (!status) throw fail('not_found')
    return { ...status, probes: this.db.prepare('SELECT label,split,strategy,results FROM evo_probes WHERE run=? ORDER BY created,rowid').all(run)
      .map(r => ({ ...r, strategy: JSON.parse(r.strategy), results: JSON.parse(r.results) })),
      usage: this.db.prepare('SELECT phase,outcome,usage FROM evo_calls WHERE run=? ORDER BY created,rowid').all(run)
        .map(r => ({ ...r, usage: r.usage ? JSON.parse(r.usage) : null })) }
  }
  start(scope, suiteId, session, { automatic = false } = {}) {
    if (automatic) throw fail('manual_only', '工具错误不能授权付费试验，请使用 /learn evolve run')
    if (this.closed || !this.config.enabled || !this.generate) throw fail('disabled', '请先配置并开启 evolution')
    if (this.running) throw fail('busy', '已有进化任务正在运行')
    const e = this.store.tx(() => {
      this.recover()
      if (this.db.prepare("SELECT 1 FROM evo_runs WHERE state='running'").get()) throw fail('busy')
      if (this.db.prepare('SELECT COUNT(*) AS n FROM evo_runs').get().n >= 10000) throw fail('run_limit', '进化记录已达上限，请先整理套件或等待保留期清理')
      const row = this.db.prepare('SELECT * FROM evo_suites WHERE scope=? AND id=?').get(scope, suiteId)
      if (!row) throw fail('not_found', '先用 /learn evolve register 路径 注册本项目验证套件')
      if (this.db.prepare("SELECT 1 FROM evo_versions v JOIN memories m ON m.id=v.memory WHERE v.scope=? AND v.suite=? AND v.state='pending_review' AND m.status IN ('candidate','trial')").get(scope, suiteId)) throw fail('review_pending', '已有待审核候选；先查看 inbox，接受试用或遗忘后再运行')
      const suite = JSON.parse(row.contract), now = this.store.now()
      if (this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE day=?').get(day(now)).n >= this.config.dailyCalls) throw fail('daily_budget')
      const key = id(), epoch = this.store.epoch()
      this.db.prepare("INSERT INTO evo_runs(id,scope,suite,suite_hash,owner,session,state,phase,created,lease,epoch) VALUES (?,?,?,?,?,?,'running','baseline',?,?,?)")
        .run(key, scope, suiteId, row.hash, this.owner, session, now, now + this.config.timeoutMs + 10000, epoch)
      this.db.prepare('UPDATE evo_suites SET last_started=? WHERE scope=? AND id=?').run(now, scope, suiteId)
      return { id: key, scope, session, suite, suiteHash: row.hash, epoch, controller: new AbortController() }
    })
    this.active = e
    this.running = this.run(e).catch(() => { try { this.store.metric('evolution_errors') } catch {} })
      .finally(() => { this.active = null; this.running = null })
    return { id: e.id, state: 'running', next: `/learn evolve show ${e.id}` }
  }
  automatic(scope, session, query) {
    return null // Legacy auto flags never authorize paid work in 0.5.1.
  }
  estimate(scope, suiteId) {
    const row = this.db.prepare('SELECT contract FROM evo_suites WHERE scope=? AND id=?').get(scope, suiteId)
    if (!row) throw fail('not_found')
    const suite = JSON.parse(row.contract), train = suite.cases.filter(c => c.split === 'train').length
    const probes = train * (1 + this.config.rounds * (this.config.candidates + 1)) + 2 * (suite.cases.length - train)
    return { suite: suiteId, command: `/learn evolve run ${suiteId}`, paidExecution: 'user_command_only',
      estimate: { fullPlanCalls: { min: probes + 2 * this.config.rounds, max: probes * this.config.maxSteps + 2 * this.config.rounds },
        runCallCap: this.config.maxCalls, dailyCallCap: this.config.dailyCalls,
        runInputByteCap: this.config.runInputBytes, dailyInputByteCap: this.config.dailyInputBytes,
        runOutputTokenCap: this.config.maxCalls * this.config.maxTokens,
        note: '完整计划范围，可能提前停止或触及额度；字节不等于 token。价格未知，不是货币硬预算；宿主重试另计。' } }
  }
  check(e) {
    e.controller.signal.throwIfAborted()
    const row = this.db.prepare('SELECT state FROM evo_runs WHERE id=?').get(e.id)
    if (row?.state !== 'running' || e.epoch !== this.store.epoch() ||
        this.db.prepare('SELECT hash FROM evo_suites WHERE scope=? AND id=?').get(e.scope, e.suite.id)?.hash !== e.suiteHash) throw fail('source_changed')
  }
  async request(e, input) {
    this.check(e)
    const inputBytes = Buffer.byteLength(input.system) + Buffer.byteLength(JSON.stringify(input.data))
    if (inputBytes > this.config.maxInputBytes) throw fail('input_limit')
    const key = this.store.tx(() => {
      const now = this.store.now()
      if (this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE run=?').get(e.id).n >= this.config.maxCalls) throw fail('run_budget')
      if (this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE day=?').get(day(now)).n >= this.config.dailyCalls) throw fail('daily_budget')
      const sizes = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN c.run=? THEN b.bytes ELSE 0 END),0) AS run,
        COALESCE(SUM(CASE WHEN c.day=? THEN b.bytes ELSE 0 END),0) AS day FROM evo_calls c JOIN evo_request_sizes b ON b.call=c.id WHERE c.day=? OR c.run=?`).get(e.id, day(now), day(now), e.id)
      if (sizes.run + inputBytes > this.config.runInputBytes || sizes.day + inputBytes > this.config.dailyInputBytes) throw fail('input_budget')
      const key = id()
      this.db.prepare("INSERT INTO evo_calls VALUES (?,?,?,?,?,'reserved',NULL)").run(key, e.id, day(now), input.phase, now)
      this.db.prepare('INSERT INTO evo_request_sizes VALUES (?,?)').run(key, inputBytes)
      return key
    })
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(fail('request_timeout')), this.config.requestTimeoutMs)
    const signal = AbortSignal.any([e.controller.signal, timeout.signal])
    let usage, abort, outcome = 'provider_failure'
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => this.generate({ ...input, signal, onUsage: value => { usage = value } })),
        new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() }),
      ])
      signal.throwIfAborted(); this.check(e); outcome = 'ok'; return response
    } catch (error) { outcome = codes.has(error.code) ? error.code : signal.aborted ? 'cancelled' : 'provider_failure'; throw fail(outcome) }
    finally {
      clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort)
      // Never persist provider bodies or late completions; reserved calls are never retried.
      const safeUsage = usage ? Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].filter(k => Number.isFinite(usage[k]) && usage[k] >= 0).map(k => [k, usage[k]])) : null
      this.db.prepare('UPDATE evo_calls SET outcome=?,usage=? WHERE id=?').run(outcome, safeUsage ? JSON.stringify(safeUsage) : null, key)
    }
  }
  async evaluate(e, strategies, split) {
    const tasks = e.suite.cases.filter(c => c.split === split)
    const jobs = strategies.flatMap((s, index) => tasks.map((task, i) => ({ s, index, task, i }))), results = strategies.map(() => [])
    let cursor = 0, error
    await Promise.all(Array.from({ length: Math.min(this.config.concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length && !error) {
        const job = jobs[cursor++]
        try {
          this.check(e)
          results[job.index][job.i] = await executeProbe({ task: job.task, strategy: job.s.strategy,
            request: input => this.request(e, input), signal: e.controller.signal, maxSteps: this.config.maxSteps, runtime: e.suite.runtime,
            executeCode: e.docker ? options => executeJavaScript(e.docker, { ...options, timeoutMs: this.config.sandboxTimeoutMs }) : undefined })
        } catch (err) { error ??= err; e.controller.abort(err) }
      }
    }))
    if (error) throw error
    this.check(e)
    return strategies.map((s, i) => {
      this.db.prepare('INSERT INTO evo_probes VALUES (?,?,?,?,?,?,?)').run(id(), e.id, s.label, split,
        JSON.stringify(s.strategy), JSON.stringify(brief(results[i])), this.store.now())
      return { ...s, results: results[i] }
    })
  }
  phase(e, phase, round) {
    this.check(e); this.db.prepare('UPDATE evo_runs SET phase=?,round=? WHERE id=?').run(phase, round, e.id)
  }
  async run(e) {
    const timer = setTimeout(() => e.controller.abort(fail('timeout')), this.config.timeoutMs)
    let state = 'failed', reason = 'provider_failure', memory = null, summary = {}
    try {
      if (e.suite.runtime === 'javascript') e.docker = await prepareDocker(this.config.dockerImage, e.controller.signal)
      const previous = this.current(e.scope, e.suite.id)
      if (previous) this.db.prepare('INSERT INTO evo_dependencies VALUES (?,?)').run(e.id, previous.memory)
      const seed = previous ? JSON.parse(previous.text) : e.suite.seed
      let [current] = await this.evaluate(e, [{ label: 'baseline', strategy: seed }], 'train')
      const baseline = current
      let lesson = previous ? JSON.parse(this.db.prepare('SELECT summary FROM evo_runs WHERE id=?').get(previous.run)?.summary ?? 'null')?.lesson ?? null : null
      const seen = new Set([hash(JSON.stringify(seed))])
      const evidence = p => ({ label: p.label, strategy: p.strategy, score: score(p.results), observations: brief(p.results) })
      for (let round = 1; round <= this.config.rounds; round++) {
        this.phase(e, 'propose', round)
        const proposal = await this.request(e, { phase: 'propose', system: EDITOR_SYSTEM,
          data: { phase: 'propose', count: this.config.candidates, goal: e.suite.title,
            tasks: e.suite.cases.filter(c => c.split === 'train').map(c => ({ id: c.id, input: c.input })),
            baseline: evidence(current), priorLesson: lesson } })
        object(proposal, ['candidates'])
        if (!Array.isArray(proposal.candidates) || proposal.candidates.length !== this.config.candidates) throw fail('invalid_strategy')
        const candidates = proposal.candidates.map(strategyOf).filter(s => {
          const fingerprint = hash(JSON.stringify(s)); if (seen.has(fingerprint)) return false; seen.add(fingerprint); return true
        }).map((strategy, i) => ({ label: `r${round}-candidate${i + 1}`, strategy }))
        if (!candidates.length) { reason = 'duplicate_candidates'; break }
        this.phase(e, 'probe', round)
        const probes = await this.evaluate(e, candidates, 'train')
        this.phase(e, 'compose', round)
        const compose = await this.request(e, { phase: 'compose', system: EDITOR_SYSTEM,
          data: { phase: 'compose', goal: e.suite.title, baseline: evidence(current), candidates: probes.map(evidence) } })
        object(compose, ['strategy', 'lesson']); object(compose.lesson, ['cue', 'lesson', 'evidence'])
        const labels = new Set([current.label, ...probes.map(p => p.label)])
        if (!Array.isArray(compose.lesson.evidence) || !compose.lesson.evidence.length || compose.lesson.evidence.some(x => !labels.has(x))) throw fail('invalid_lesson')
        const nextLesson = { cue: clean(compose.lesson.cue, 300), lesson: clean(compose.lesson.lesson, 800), evidence: compose.lesson.evidence }
        const composed = strategyOf(compose.strategy)
        this.phase(e, 'verify_composition', round)
        // Even a composition identical to a candidate is executed independently.
        const [combined] = await this.evaluate(e, [{ label: `r${round}-composed`, strategy: composed }], 'train')
        let winner = current
        for (const p of [...probes, combined]) if (better(p.results, winner.results)) winner = p
        if (winner === current) { reason = 'no_improvement'; break }
        current = winner; lesson = nextLesson
        reason = round === this.config.rounds ? 'round_limit' : 'improved'
        // A new round needs all candidate/composition probes plus the final baseline/winner holdout.
        const used = this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE run=?').get(e.id).n
        const dailyUsed = this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE day=?').get(day(this.store.now())).n
        const trainCount = e.suite.cases.filter(c => c.split === 'train').length
        const validationCount = e.suite.cases.length - trainCount
        const nextRoundAndValidation = ((this.config.candidates + 1) * trainCount + 2 * validationCount) * this.config.maxSteps + 2
        if (round < this.config.rounds && Math.min(this.config.maxCalls - used, this.config.dailyCalls - dailyUsed) < nextRoundAndValidation) {
          reason = 'validation_reserve'; break
        }
      }
      summary = { baseline: score(baseline.results), selected: score(current.results), selectedLabel: current.label,
        lesson: lesson ? { ...lesson, status: 'model_interpretation' } : null }
      if (current === baseline) { state = 'unchanged'; return }
      this.phase(e, 'holdout', this.db.prepare('SELECT round FROM evo_runs WHERE id=?').get(e.id).round)
      // Validation inputs/answers never enter the editor; evaluate only after selection.
      const [baseValidation, nextValidation] = await this.evaluate(e, [
        { label: 'baseline-validation', strategy: baseline.strategy }, { label: 'selected-validation', strategy: current.strategy },
      ], 'validation')
      summary.validation = { baseline: score(baseValidation.results), selected: score(nextValidation.results) }
      const all = [...current.results, ...nextValidation.results], baseAll = [...baseline.results, ...baseValidation.results]
      if (!all.every(r => r.pass) || !better(all, baseAll)) { state = 'rejected'; reason = 'validation_failed'; return }
      this.phase(e, 'adopt', this.db.prepare('SELECT round FROM evo_runs WHERE id=?').get(e.id).round)
      memory = this.publish(e, current.strategy, previous, summary)
      state = 'awaiting_review'; reason = 'fixed_suite_passed_requires_review'
    } catch (error) {
      reason = codes.has(error.code) ? error.code : 'invalid_strategy'
      if (error.cleanupError) summary.failure = { primary: error.code, cleanup: error.cleanupError.code }
      state = ['blocked_strategy', 'duplicate_strategy'].includes(reason) ? 'rejected' : ['cancelled', 'timeout', 'source_changed'].includes(reason) ? 'interrupted' : 'failed'
    } finally {
      clearTimeout(timer)
      if (e.epoch !== this.store.epoch()) {
        summary = {}; this.db.prepare('DELETE FROM evo_probes WHERE run=?').run(e.id)
      }
      this.db.prepare('UPDATE evo_runs SET state=?,phase=?,finished=?,reason=?,memory=?,summary=? WHERE id=?')
        .run(state, 'done', this.store.now(), reason, memory, JSON.stringify(summary), e.id)
    }
  }
  publish(e, strategy, previous, summary) {
    return this.store.tx(() => {
      this.check(e)
      if (previous && (this.store.get(previous.memory, e.scope)?.status !== 'active')) throw fail('source_changed')
      const text = skillText({ ...strategy, title: clean(`${e.suite.title}：${strategy.title}`, 200),
        preconditions: [clean(`仅适用 ${e.suite.keywords.join('、')}；自动验证范围 ${e.suite.id}，不代表任意任务成功`, 300), ...strategy.preconditions].slice(0, 12) })
      skillText(clean(text, 3200)) // Persist only well-formed redacted candidate JSON.
      const source = this.store.capture({ eventId: `evolution:${e.id}`, session: e.session, scope: e.scope, role: 'tool',
        text: `隔离任务执行与固定验收通过；run=${e.id}；${JSON.stringify(summary)}`, priority: 0 })
      const memory = this.store.add({ scope: e.scope, kind: 'skill', text, sourceIds: [source], origin: 'evolution',
        parentIds: previous ? [previous.memory] : [] })
      const saved = this.db.prepare('SELECT origin,status FROM memories WHERE id=?').get(memory)
      if (saved.origin !== 'evolution' || saved.status !== 'candidate' || memory === previous?.memory || this.db.prepare('SELECT 1 FROM evo_versions WHERE memory=?').get(memory)) throw fail('duplicate_strategy')
      this.db.prepare("INSERT INTO evo_versions VALUES (?,?,?,?,?,?,'pending_review',?)")
        .run(memory, e.scope, e.suite.id, e.suiteHash, e.id, previous?.memory ?? null, this.store.now())
      return memory
    })
  }
  async cancel(scope, run) {
    if (this.active?.scope === scope && (!run || this.active.id === run)) {
      this.active.controller.abort(fail('cancelled')); await this.running; return { cancelled: true }
    }
    return { cancelled: false, note: '当前进程没有匹配的运行任务' }
  }
  rollback(scope, suite) {
    return this.store.tx(() => {
      if (this.db.prepare("SELECT 1 FROM evo_runs WHERE scope=? AND suite=? AND state='running'").get(scope, suite)) throw fail('busy')
      const current = this.current(scope, suite)
      if (!current) throw fail('not_found')
      this.retire(current.memory)
      const row = this.store.get(current.memory, scope)
      this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?,?)').run(`memory:${row.fingerprint}`, this.store.now())
      this.db.prepare("UPDATE evo_versions SET state='rolled_back' WHERE memory=?").run(current.memory)
      const parent = current.parent ? this.store.get(current.parent, scope) : null
      if (parent && !this.store.blocked(`memory:${parent.fingerprint}`) && parent.sources.length &&
          parent.performance.passedSessions >= 2 &&
          this.db.prepare('SELECT 1 FROM evo_versions WHERE memory=? AND suite_hash=?').get(parent.id, current.suite_hash) &&
          !parent.feedback.some(f => f.verdict === 'fail') &&
          !this.db.prepare("SELECT 1 FROM trials WHERE memory=? AND review='harmed'").get(parent.id)) {
        this.db.prepare("UPDATE memories SET status='active',updated=? WHERE id=?").run(this.store.now(), parent.id)
        this.db.prepare("UPDATE evo_versions SET state='current' WHERE memory=? AND suite_hash=?").run(parent.id, current.suite_hash)
      }
      this.store.bump()
      return { retired: current.memory, current: this.current(scope, suite)?.memory ?? null }
    })
  }
  async command(raw, session, scope) {
    const match = raw.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/), verb = match?.[1] ?? 'status', value = match?.[2]?.trim() ?? ''
    if (verb === 'example') {
      if (!['memory', 'javascript'].includes(value) || !session.header?.cwd || !isAbsolute(session.header.cwd)) throw fail('invalid_path', '在项目中使用 evolve example memory 或 javascript')
      const folder = resolve(session.header.cwd, '.dsh-soul'), path = resolve(folder, `evolution-${value}.json`)
      const content = await readFile(new URL(`../examples/evolution-${value}.json`, import.meta.url), 'utf8')
      await mkdir(folder, { recursive: true }); await writeFile(path, content, { flag: 'wx' })
      return { path, next: `/learn evolve register ${path}`, note: '示例用于学习配置；请扩充为你的实际任务与验收条件' }
    }
    if (verb === 'register') {
      let path = value.replace(/^"(.*)"$/, '$1')
      if (!path || (!isAbsolute(path) && !session.header?.cwd)) throw fail('invalid_path', '需要绝对路径或会话工作目录')
      path = resolve(session.header?.cwd ?? '.', path)
      const { stat } = await import('node:fs/promises')
      if ((await stat(path)).size > 256000) throw fail('suite_too_large')
      return this.register(scope, await readFile(path, 'utf8'))
    }
    if (verb === 'run') return this.start(scope, value, String(session.id))
    if (verb === 'estimate') return this.estimate(scope, value)
    if (verb === 'list') return this.list(scope)
    if (verb === 'status') return { enabled: this.config.enabled, route: { provider: this.config.provider, model: this.config.model, editorModel: this.config.editorModel },
      limits: this.config, estimates: this.list(scope).map(s => this.estimate(scope, s.id)),
      inputBytesToday: this.db.prepare('SELECT COALESCE(SUM(b.bytes),0) AS n FROM evo_request_sizes b JOIN evo_calls c ON c.id=b.call WHERE c.day=?').get(day(this.store.now())).n,
      callsToday: this.db.prepare('SELECT COUNT(*) AS n FROM evo_calls WHERE day=?').get(day(this.store.now())).n, runs: this.status(scope, value) }
    if (verb === 'show') return this.inspect(scope, value)
    if (verb === 'cancel') return this.cancel(scope, value)
    if (verb === 'rollback') return this.rollback(scope, value)
    if (verb === 'unregister') {
      if (this.active?.scope === scope && this.active.suite.id === value) await this.cancel(scope, this.active.id)
      if (this.db.prepare("SELECT 1 FROM evo_runs WHERE scope=? AND suite=? AND state='running'").get(scope, value)) throw fail('busy')
      const memories = this.db.prepare('SELECT memory FROM evo_versions WHERE scope=? AND suite=?').all(scope, value)
      for (const { memory } of memories) if (this.store.get(memory, scope)) this.store.forget(memory, scope)
      this.store.tx(() => {
        this.db.prepare('DELETE FROM evo_probes WHERE run IN (SELECT id FROM evo_runs WHERE scope=? AND suite=?)').run(scope, value)
        this.db.prepare('UPDATE evo_runs SET summary=NULL WHERE scope=? AND suite=?').run(scope, value)
        this.db.prepare('DELETE FROM evo_suites WHERE scope=? AND id=?').run(scope, value)
        this.store.bump()
      })
      return { removed: value, note: '保留不含正文的调用额度；不删除用户提供的原始套件文件' }
    }
    throw fail('unknown_command', '使用 evolve example/register/run/list/status/show/cancel/rollback/unregister')
  }
  async stop() { this.closed = true; this.active?.controller.abort(fail('cancelled')); await this.running }
}
