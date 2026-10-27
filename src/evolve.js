import { bounded, bytes, day, fail, hash, id, taskKey as fingerprint, terms as termSet } from './util.js'
import { Budget } from './budget.js'
import { diagnose } from './diagnose.js'
import { edit, MAX_STEPS as EDITOR_STEPS } from './edit.js'
import { checkStructure, decide, turnCounter, MAX_TAX_BYTES } from './gate.js'
import { buildContrast, patternOf, snapshot, TRIGGER_KINDS } from './lesson.js'
import { probe } from './probe.js'
import { fold, settle, rollbackTo } from './watch.js'
import { sizeReport, treeId, diffTrees, taxOf, COMPONENTS } from './tree.js'
import { validationSettings, normalizeChecks, classifyPair } from './validation.js'

/** A probe arm cannot produce a useful paired result in fewer steps than this. */
const MIN_PROBE_STEPS = 2

/**
 * Divide the episode call budget across the editor and every probe arm before spending.
 * `probeSteps` is a ceiling, not a promise: with four arms and a 60-call episode, a 40-step
 * arm would starve the later arms and fail the episode after the earlier ones were paid for.
 * Reserving the editor's worst case and splitting the remainder keeps every arm comparable.
 */
export function probeStepBudget(budget, trials) {
  const perArm = Math.floor((budget.episodeCalls - EDITOR_STEPS) / (trials * 2))
  return Math.max(0, Math.min(budget.probeSteps, perArm))
}

/**
 * Episode orchestrator.
 *
 * The whole refinement loop lives here so that every state transition is in one readable
 * place. Steps that cost money are marked `$`; everything else is free.
 *
 *   diagnose   (free)  divergence -> one component
 *   edit       ($)     one agentic editor session
 *   structure  (free)  anchors, lint, whitelist, byte caps
 *   probe      ($)     replay baseline/candidate pairs from the same pinned commit
 *   checks     ($)     deterministic project checks, only when the project declares them
 *   decide     (free)  objective outcomes, repeated efficiency gains, cooldown
 *   shadow     (free)  real outcomes require explicit verification; negative signals roll back
 */
export class Evolve {
  constructor({ store, config, generate, execute, now = Date.now, logger = () => {}, onChange = () => {} }) {
    this.store = store
    this.config = config
    this.generate = generate
    this.execute = execute
    this.now = now
    this.logger = logger
    this.onChange = onChange
    this.validation = validationSettings(config)
    this.budget = new Budget(store, config.budget, now)
    this.running = null
    this.closed = false
    this.cache = new Map()
  }

  enabled() { return !!this.config.enabled && !this.closed }

  /** Seed or read the current stable tree for a project. */
  current(scope) {
    const latest = this.store.latest(scope, ['stable', 'shadow'])
    if (!latest) { this.cache.delete(scope); return null }
    const cached = this.cache.get(scope)
    if (cached?.rev === latest.id && cached.state === latest.state) return cached
    const value = { rev: latest.id, files: Object.freeze(this.store.materialize(latest.id)), state: latest.state }
    this.cache.delete(scope)
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(scope,value)
    return value
  }

  ensure(scope, files) {
    const current = this.current(scope)
    if (current) return current
    const rev = this.store.putRev(scope, files, { state: 'stable', reason: 'seed', taxes: taxOf(files) })
    this.store.log({ rev, scope, action: 'seed', actor: 'system', detail: { files: Object.keys(files).length } })
    this.onChange()
    return { rev, files, state: 'stable' }
  }

  /**
   * Entry point for a divergence worth refining.
   * @param {{scope:string, taskKey:string, trigger:string, divergence:object, metrics:object,
   *          trajectory:string, task:string, cwd?:string, checks?:object[], taskTerms?:string[],
   *          lesson?:object, contrast?:string}} input
   */
  async start(input) {
    if (!this.enabled()) return { started: false, reason: 'disabled' }
    if (!this.generate) return { started: false, reason: 'no_model_route' }
    if (!this.execute) return { started: false, reason: 'no_executor' }
    // Resolve from storage on every entry, including direct session observations.
    const matches = this.store.matchingLessons(input.scope, {
      taskKey: input.taskKey, terms: input.taskTerms ?? termSet(input.task ?? ''),
    }, TRIGGER_KINDS)
    const explicit = input.lesson?.id ? this.store.lesson(input.lesson.id) : null
    if (input.lesson && (!explicit || explicit.scope !== input.scope)) return { started: false, reason: 'invalid_lesson' }
    const lessons = explicit ? [explicit, ...matches] : matches
    if (lessons.some(l => l.state === 'retired')) return { started: false, reason: 'lesson_retired' }
    if (lessons.some(l => l.state === 'compiled')) return { started: false, reason: 'lesson_compiled' }
    const lesson = explicit ?? matches[0]
    if (lesson) input = { ...input, lesson }
    try {
      input = { ...input, checks: normalizeChecks(input.checks ?? this.config.checks) }
      input.replay = await this.execute.preflight?.(input)
    }
    catch (error) { return { started: false, reason: error.code ?? 'probe_preflight' } }
    if (!this.enabled()) return { started: false, reason: 'disabled' }
    if (this.running) return { started: false, reason: 'busy' }
    const { scope } = input
    if (this.store.running(scope)) return { started: false, reason: 'episode_running' }

    const gate = this.budget.canStart(scope)
    if (!gate.ok) return { started: false, reason: gate.reason }

    const steps = probeStepBudget(this.config.budget, this.validation.trials)
    if (steps < MIN_PROBE_STEPS) {
      return { started: false, reason: 'budget_envelope', have: this.config.budget.episodeCalls,
        need: 2 * this.validation.trials * MIN_PROBE_STEPS + EDITOR_STEPS }
    }

    const current = this.current(scope)
    if (!current) return { started: false, reason: 'no_harness' }

    // Cooldown is measured in observed turns, not wall clock: an edit's cost is a cache
    // prefix rebuild amortised over turns, so turns are the honest unit. Seeding a project
    // is not an adoption, so the clock starts only at the first real shadow adoption.
    const turns = turnCounter(this.store, scope)
    const adoptedAt = this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(`adoptAt:${scope}`)?.value
    if (adoptedAt !== undefined && adoptedAt !== null) {
      const sinceTurns = turns.get() - Number(adoptedAt)
      if (sinceTurns < this.config.budget.cooldownTurns) {
        return { started: false, reason: 'cooldown', have: sinceTurns, need: this.config.budget.cooldownTurns }
      }
    }
    if (this.store.openWatches(scope).length) return { started: false, reason: 'trial_pending', next: '/evolve verify 或 /evolve rollback' }

    const diagnosis = input.diagnosis ?? diagnose(input.divergence)
    if (this.execute.supportedTargets && !this.execute.supportedTargets.includes(diagnosis.target)) return { started: false, reason: 'component_not_connected', target: diagnosis.target }
    const episode = this.store.createEpisode({
      scope, taskKey: input.taskKey, trigger: input.trigger,
      fromRev: current.rev, divergence: input.divergence, target: diagnosis.target,
      lesson: input.lesson?.id ?? null,
    })
    if (input.trajectory) this.store.addEvidence(episode, 'trajectory', input.trajectory)
    this.store.log({ rev: current.rev, scope, action: 'episode_start', actor: 'system',
      detail: { episode, trigger: input.trigger, target: diagnosis.target, rule: diagnosis.rule,
        lesson: input.lesson?.id ?? null } })

    this.running = this.run({ episode, input, current, diagnosis, steps, lesson: input.lesson ?? null })
      .finally(() => { this.running = null })
    return { started: true, episode, target: diagnosis.target, rule: diagnosis.rule, steps,
      lesson: input.lesson?.id ?? null }
  }

  async run({ episode, input, current, diagnosis, steps = this.config.budget.probeSteps, lesson = null }) {
    const { scope } = input
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(fail('episode_timeout')), this.config.budget.episodeTimeoutMs)
    const cost = { calls: 0, inputBytes: 0 }
    let state = 'failed', reason = null, toRev = null
    try {
      // ---- edit ($) -------------------------------------------------------
      // The contrast is free to build and carries the signal GEPA/BudgetAPO say matters
      // most: a few failing examples plus a related success. It is data, never instructions.
      const related = lesson?.success ? null : this.store.relatedLesson(scope, {
        taskKey: input.taskKey, terms: input.taskTerms ?? [],
      })
      const contrast = input.contrast ?? buildContrast({
        lesson,
        observed: lesson?.detail ?? input.metrics ?? null,
        success: lesson?.success ?? related?.success ?? null,
      })
      this.store.addEvidence(episode, 'contrast', contrast)
      const evidence = this.store.episode(episode, scope).evidence
      const editor = await edit({
        generate: this.request(scope, episode, cost),
        signal: controller.signal,
        context: {
          task: input.task, target: diagnosis.target, why: diagnosis.why, hint: diagnosis.hint,
          contrast,
          files: current.files,
          evidence: evidence.map(e => ({ ...e, body: () => this.store.readEvidence(e.id) })),
        },
        readEvidence: key => this.store.readEvidence(key),
      })
      this.store.addEvidence(episode, 'diff', JSON.stringify(diffTrees(current.files, { ...current.files, ...editor.files }).hunks))
      this.store.addEvidence(episode, 'editor', JSON.stringify({ why: editor.why, reads: editor.reads, writes: editor.writes }))

      const next = { ...current.files, ...editor.files }

      // ---- structure (free) ----------------------------------------------
      const structure = checkStructure({ target: diagnosis.target, base: current.files, next })
      if (!structure.ok) return this.finish(episode, { state: 'rejected', reason: 'structure', detail: structure.violations, cost })
      const taxDelta = structure.tax - taxOf(current.files)

      // Pay for matched baseline/candidate runs from the SAME pinned commit, input,
      // route and verifier. Alternate order to reduce warm-cache/order bias.
      const pairs = []
      for (let trial = 0; trial < this.validation.trials; trial++) {
        const pair = {}
        for (const arm of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const execution = await probe({
            execute: this.execute, files: arm === 'baseline' ? current.files : next,
            task: input.task, root: input.cwd ?? null, replay: input.replay, arm,
            harnessFolder: this.config.harnessFolder, signal: controller.signal,
            timeoutMs: this.config.budget.armTimeoutMs, maxSteps: steps, parent: input.parent, checks: input.checks,
            reserve: payload => {
              controller.signal.throwIfAborted()
              const ticket = this.budget.request(scope, episode, arm, payload)
              if (!ticket.ok) throw fail(ticket.reason)
              cost.calls++; cost.inputBytes += ticket.size
              return { settle: (outcome, usage) => this.budget.settle(ticket.callId, outcome, usage) }
            },
          })
          this.store.addEvidence(episode, `${arm}-${trial + 1}`, JSON.stringify(execution))
          if (!execution.ok) throw fail(execution.reason ?? 'probe_failed')
          if (execution.checks?.length !== input.checks.length) throw fail('missing_candidate_checks')
          if (JSON.stringify(execution.checks.map(c => c.name)) !== JSON.stringify(input.checks.map(c => c.name))) throw fail('incomparable_checks')
          if (arm === 'candidate' && !execution.metrics.complete) throw fail('probe_incomplete')
          if (arm === 'candidate' && !execution.checks.every(c => c.ok === true)) return this.finish(episode, {state:'rejected',reason:'candidate_failed_verification',cost,metrics:execution.metrics})
          pair[arm] = execution
        }
        pairs.push(pair)
        // Adoption requires EVERY pair to show a quality or efficiency win. A pair that
        // contributes neither makes that unreachable, so paying for the remaining trials can
        // never change the verdict. Stop here and keep the evidence that justified it.
        const verdict = classifyPair(pair, this.validation)
        if (verdict.valid && !verdict.quality && !verdict.efficiency && trial < this.validation.trials - 1) {
          this.store.addEvidence(episode, 'paired-validation', JSON.stringify({ replay: input.replay, pairs, earlyStop: true }))
          return this.finish(episode, { state: 'rejected', reason: verdict.reason ?? 'no_repeatable_gain',
            detail: { earlyStop: true, pair: trial + 1, evidence: verdict }, cost, metrics: pair.candidate.metrics })
        }
      }
      this.store.addEvidence(episode, 'paired-validation', JSON.stringify({ replay: input.replay, pairs }))
      const execution = pairs.at(-1).candidate
      controller.signal.throwIfAborted()
      if (this.current(scope)?.rev !== current.rev) throw fail('stale_parent_revision')

      // ---- decide (free) --------------------------------------------------
      const decision = decide({
        structure,
        pairs,
        validation: this.validation,
        cooldown: { ok: true, have: 0, need: 0 },
      })
      if (!decision.adopt) {
        return this.finish(episode, { state: 'rejected', reason: decision.reasons.join(' | '), detail: decision, cost, metrics: execution.metrics })
      }

      // ---- shadow adoption (free) -----------------------------------------
      toRev = this.store.putRev(scope, next, { parent: current.rev, state: 'shadow', reason: `episode:${episode}`, taxes: structure.tax })
      this.store.setRevState(current.rev, 'stable')
      this.store.openWatch(toRev, scope, input.taskKey, { ...execution.metrics, verification: input.replay ?? null, taskTerms: input.taskTerms ?? null }, this.config.budget.shadowWindow)
      this.store.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(`adoptAt:${scope}`, String(turnCounter(this.store, scope).get()))
      this.store.log({ rev: toRev, scope, action: 'shadow', actor: 'evolve', gate: { decision },
        detail: { episode, target: diagnosis.target, tax: structure.tax, taxDelta, metrics: execution.metrics } })
      state = 'shadow'
      this.onChange()
      reason = decision.reasons.join(' | ') || 'adopted'
      return this.finish(episode, { state, reason, toRev, cost, detail: decision })
    } catch (error) {
      reason = error?.code ?? 'internal'
      // A scope violation attempted by the editor is a rejection by the structure gate,
      // not an internal failure: the distinction is what makes the ledger readable.
      // `retired_revision` is also a rejection: the candidate is byte-identical to a tree
      // that was already rolled back, so re-proposing it is evidence against the lesson,
      // not a transient failure that deserves an unlimited retry budget.
      if (['off_target', 'invalid_path', 'not_managed', 'escape', 'too_large', 'read_limit', 'retired_revision'].includes(reason)) {
        state = 'rejected'
      } else if (reason === 'episode_timeout') {
        state = 'interrupted'
      }
      return this.finish(episode, { state, reason, cost, detail: { message: bounded(error?.message ?? '', 400) } })
    } finally {
      clearTimeout(timer)
      this.controller = null
    }
  }

  finish(episode, { state, reason, toRev = null, cost, detail = null, metrics = null }) {
    this.store.finishEpisode(episode, { toRev, cost, state, reason })
    const row = this.store.db.prepare('SELECT scope, lesson FROM episode WHERE id=?').get(episode)
    const scope = row?.scope
    if (row?.lesson) {
      const lesson = this.store.settleLesson(row.lesson, { state, rev: toRev, episode, reason })
      if (lesson) this.store.log({ rev: toRev, scope, action: `lesson_${lesson.state}`, actor: 'evolve',
        detail: { lesson: lesson.id, kind: lesson.kind, support: lesson.support,
          contradictions: lesson.contradictions, reason } })
    }
    this.store.log({ rev: toRev, scope, action: `episode_${state}`, actor: 'evolve', gate: detail, detail: { reason, metrics } })
    return { episode, state, reason, rev: toRev, cost, detail, lesson: row?.lesson ?? null }
  }

  /** Bounded, budgeted model call. Every call is reserved before dispatch. */
  request(scope, episode, cost) {
    return async ({ phase, system, data, signal }) => {
      const payload = JSON.stringify({ system, data })
      const reservation = this.budget.request(scope, episode, phase, payload)
      if (!reservation.ok) throw fail(reservation.reason, `额度不足：${reservation.reason}`)
      cost.calls += 1
      cost.inputBytes += reservation.size
      let outcome = 'provider_failure', usage
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(fail('request_timeout')), this.config.budget.requestTimeoutMs)
      const merged = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
      try {
        const response = await this.generate({ system, data, phase, signal: merged, onUsage: value => { usage = value } })
        merged.throwIfAborted()
        if (!response || typeof response !== 'object') throw fail('invalid_output')
        outcome = 'ok'
        return response
      } catch (error) {
        outcome = merged.aborted ? (timeout.signal.aborted ? 'request_timeout' : 'cancelled') : (error?.code ?? 'provider_failure')
        throw fail(outcome, error?.message ?? '模型请求失败')
      } finally {
        clearTimeout(timer)
        this.budget.settle(reservation.callId, outcome, usage)
      }
    }
  }

  /** Fold one observed real turn into the shadow windows. Called from session events. */
  observe({ scope, taskKey, taskTerms, corrections, toolErrors, complete, verified = false }) {
    if (!this.enabled()) return []
    const decisions = fold(this.store, { scope, taskKey, taskTerms, corrections, toolErrors, complete, verified })
    for (const decision of decisions) {
      settle(this.store, decision.rev, decision.verdict, scope)
      // A shadow failure invalidates the experience that compiled that revision. It must
      // re-earn its place; after two failures the cluster retires instead of being retried.
      if (decision.verdict === 'fail') {
        const reopened = this.store.reopenLessonsForRev(decision.rev, scope)
        if (reopened) this.store.log({ rev: decision.rev, scope, action: 'lesson_reopened', actor: 'watch',
          detail: { count: reopened, reason: 'shadow_failed' } })
      }
    }
    if (decisions.length) this.onChange()
    return decisions
  }

  rollback(scope, rev) {
    const target = rev ?? (() => {
      const current = this.store.latest(scope, ['shadow', 'stable'])
      return current?.parent ?? null
    })()
    if (!target) return { ok: false, reason: 'no_parent' }
    const result = rollbackTo(this.store, scope, target)
    if (result.ok) this.onChange()
    return result
  }

  /** Supported experience clusters that may justify a paid compilation episode. */
  eligibleLessons(scope, threshold = this.config.budget.repeatThreshold) {
    return this.store.lessonCandidates(scope, threshold, {
      kinds: TRIGGER_KINDS, windowMs: this.config.budget.repeatWindowMs,
    })
  }

  eligibleLesson(scope, threshold = this.config.budget.repeatThreshold) {
    return this.eligibleLessons(scope, threshold)[0] ?? null
  }

  /**
   * Free experience observation. Called after every real turn; no model is consulted.
   * The returned row is a staging record, not a prompt and not a version.
   */
  recordObservation({ scope, state, hadDivergence = false, trajectory = null }) {
    if (!this.enabled() || !state) return null
    const pattern = patternOf(state, { hadDivergence })
    if (!pattern) return null
    const key = state.taskKey ?? fingerprint({ scope, text: state.text ?? '' })
    const taskTerms = state.text != null ? termSet(state.text) : []
    const lesson = this.store.recordLesson({
      scope, kind: pattern.kind, taskKey: key, terms: taskTerms,
      task: pattern.task, summary: pattern.summary, detail: pattern.detail,
      success: pattern.success, divergence: pattern.divergence, trajectory,
    })
    // Crossing the support threshold only changes the pool status. It still buys nothing
    // until the user runs /evolve run; success-only kinds are never candidates.
    if (lesson && TRIGGER_KINDS.includes(lesson.kind) && lesson.state === 'observed' &&
      lesson.support >= this.config.budget.repeatThreshold) {
      return this.store.markLessonCandidate(lesson.id)
    }
    return lesson
  }

  /** A declared verifier passed on a real task: positive evidence for the same task family. */
  recordVerified({ scope, taskKey, taskTerms = [], task = null, state = null, rev = null, checks = null }) {
    if (!this.enabled() || !taskKey) return null
    return this.store.recordLesson({
      scope, kind: 'verified_success', taskKey, terms: taskTerms, task,
      summary: '真实任务验收通过', detail: { checks: checks ?? null, rev },
      success: snapshot(state ?? {}), divergence: null, trajectory: null,
    })
  }

  /**
   * Cost-and-outcome report. It deliberately does not claim generalization: retention and
   * transfer need fresh held-out tasks, so this reports only what was actually observed.
   */
  report(scope) {
    const episodes = this.store.db.prepare('SELECT state, reason, cost FROM episode WHERE scope=?').all(scope)
    const byState = {}, byReason = {}
    let calls = 0, inputBytes = 0, costed = 0
    for (const episode of episodes) {
      byState[episode.state] = (byState[episode.state] ?? 0) + 1
      byReason[episode.reason ?? 'none'] = (byReason[episode.reason ?? 'none'] ?? 0) + 1
      if (!episode.cost) continue
      try {
        const cost = JSON.parse(episode.cost)
        calls += Number(cost.calls) || 0
        inputBytes += Number(cost.inputBytes) || 0
        costed++
      } catch { /* ignore a corrupt cost column; the ledger still has the episode */ }
    }
    const watches = this.store.db.prepare('SELECT verdict, COUNT(*) n FROM watch WHERE scope=? GROUP BY verdict').all(scope)
    const pass = watches.find(row => row.verdict === 'pass')?.n ?? 0
    const fail = watches.find(row => row.verdict === 'fail')?.n ?? 0
    const finished = episodes.filter(episode => episode.state !== 'running').length
    const shadow = byState.shadow ?? 0
    return {
      scope,
      lessons: this.store.lessonStats(scope),
      episodes: {
        total: episodes.length, finished, byState, byReason,
        // Reaching shadow is not adoption: the trial still has to pass. Keep the two rates
        // separate so a report cannot turn "entered trial" into "promoted".
        shadowRate: finished ? shadow / finished : 0,
        promotionRate: pass + fail ? pass / (pass + fail) : 0,
        rollbackRate: pass + fail ? fail / (pass + fail) : 0,
      },
      trials: { pass, fail, pending: this.store.openWatches(scope).length },
      cost: {
        episodes: costed, calls, inputBytes,
        callsPerEpisode: costed ? calls / costed : 0,
        bytesPerEpisode: costed ? inputBytes / costed : 0,
        callsByPhase: this.store.callStatsForScope(scope),
      },
      budget: this.budget.report(scope),
      note: '经验库与观察不花模型调用；这里只报告已发生的采纳、回滚和成本。留存/迁移需要另外重跑旧任务，不能由成功率代替。',
    }
  }

  status(scope, { files } = {}) {
    const current = this.current(scope)
    const report = current ? sizeReport(current.files) : (files ? sizeReport(files) : null)
    return {
      enabled: this.enabled(),
      route: this.config.enabled ? { provider: this.config.provider, model: this.config.model } : null,
      validation: { trials: this.validation.trials, runs: this.validation.trials * 2, minimumEfficiencyGain: this.validation.minimumGain,
        checksRequired: true, promotion: 'verified_real_tasks', note: '同一任务的重复对照不是泛化证明；试用期需 /evolve verify 验收新任务。' },
      current: current ? { rev: current.rev, state: current.state, tax: taxOf(current.files) } : null,
      fixedTax: report ? { bytes: report.tax, cap: MAX_TAX_BYTES, components: report.rows } : null,
      budget: this.budget.report(scope),
      lessons: this.store.lessonStats(scope),
      openWatches: this.store.openWatches(scope).map(w => ({ rev: w.rev, remaining: w.remaining, task: w.task_key })),
      episodes: this.store.recentEpisodes(scope, 10),
      ledger: this.store.ledger(scope, 8),
    }
  }

  async stop() {
    this.closed = true
    this.controller?.abort(fail('cancelled'))
    await this.running?.catch(() => {})
  }
}

export { COMPONENTS, diffTrees, treeId, hash, id, day, bytes }
