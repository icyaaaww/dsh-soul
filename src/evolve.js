import { bounded, bytes, day, fail, hash, id } from './util.js'
import { Budget } from './budget.js'
import { diagnose } from './diagnose.js'
import { edit } from './edit.js'
import { checkStructure, decide, turnCounter, MAX_TAX_BYTES } from './gate.js'
import { probe } from './probe.js'
import { fold, settle, rollbackTo } from './watch.js'
import { sizeReport, treeId, diffTrees, taxOf, COMPONENTS } from './tree.js'

/**
 * Episode orchestrator.
 *
 * The whole refinement loop lives here so that every state transition is in one readable
 * place. Steps that cost money are marked `$`; everything else is free.
 *
 *   diagnose   (free)  divergence -> one component
 *   edit       ($)     one agentic editor session
 *   structure  (free)  anchors, lint, whitelist, byte caps
 *   probe      ($)     execute the candidate ONCE (baseline is the recorded trajectory)
 *   checks     ($)     deterministic project checks, only when the project declares them
 *   decide     (free)  A/B veto, cooldown, tax
 *   shadow     (free)  real traffic falsifies it; rollback on any Tier-D signal
 */
export class Evolve {
  constructor({ store, config, generate, execute, now = Date.now, logger = () => {} }) {
    this.store = store
    this.config = config
    this.generate = generate
    this.execute = execute
    this.now = now
    this.logger = logger
    this.budget = new Budget(store, config.budget, now)
    this.running = null
    this.closed = false
  }

  enabled() { return !!this.config.enabled && !this.closed }

  /** Seed or read the current stable tree for a project. */
  current(scope) {
    const latest = this.store.latest(scope, ['stable', 'shadow'])
    return latest ? { rev: latest.id, files: this.store.materialize(latest.id), state: latest.state } : null
  }

  ensure(scope, files) {
    const current = this.current(scope)
    if (current) return current
    const rev = this.store.putRev(scope, files, { state: 'stable', reason: 'seed', taxes: taxOf(files) })
    this.store.log({ rev, scope, action: 'seed', actor: 'system', detail: { files: Object.keys(files).length } })
    return { rev, files, state: 'stable' }
  }

  /**
   * Entry point for a divergence worth refining.
   * @param {{scope:string, taskKey:string, trigger:string, divergence:object, metrics:object,
   *          trajectory:string, task:string, cwd?:string, checks?:object[]}} input
   */
  async start(input) {
    if (!this.enabled()) return { started: false, reason: 'disabled' }
    if (!this.generate) return { started: false, reason: 'no_model_route' }
    if (!this.execute) return { started: false, reason: 'no_executor' }
    try { await this.execute.preflight?.(input) }
    catch (error) { return { started: false, reason: error.code ?? 'probe_preflight' } }
    if (!this.enabled()) return { started: false, reason: 'disabled' }
    if (this.running) return { started: false, reason: 'busy' }
    const { scope } = input
    if (this.store.running(scope)) return { started: false, reason: 'episode_running' }

    const gate = this.budget.canStart(scope)
    if (!gate.ok) return { started: false, reason: gate.reason }

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

    const diagnosis = input.diagnosis ?? diagnose(input.divergence)
    if (this.execute.supportedTargets && !this.execute.supportedTargets.includes(diagnosis.target)) return { started: false, reason: 'component_not_connected', target: diagnosis.target }
    const episode = this.store.createEpisode({
      scope, taskKey: input.taskKey, trigger: input.trigger,
      fromRev: current.rev, divergence: input.divergence, target: diagnosis.target,
    })
    this.store.addEvidence(episode, 'trajectory', input.trajectory)
    this.store.log({ rev: current.rev, scope, action: 'episode_start', actor: 'system',
      detail: { episode, trigger: input.trigger, target: diagnosis.target, rule: diagnosis.rule } })

    this.running = this.run({ episode, input, current, diagnosis }).finally(() => { this.running = null })
    return { started: true, episode, target: diagnosis.target, rule: diagnosis.rule }
  }

  async run({ episode, input, current, diagnosis }) {
    const { scope } = input
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(fail('episode_timeout')), this.config.budget.episodeTimeoutMs)
    const cost = { calls: 0, inputBytes: 0 }
    let state = 'failed', reason = null, toRev = null
    try {
      // ---- edit ($) -------------------------------------------------------
      const evidence = this.store.episode(episode, scope).evidence
      const editor = await edit({
        generate: this.request(scope, episode, cost),
        signal: controller.signal,
        context: {
          task: input.task, target: diagnosis.target, why: diagnosis.why, hint: diagnosis.hint,
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

      // ---- probe ($) ------------------------------------------------------
      const execution = await probe({
        execute: this.execute, files: next, task: input.task, root: input.cwd ?? null,
        harnessFolder: this.config.harnessFolder, signal: controller.signal,
        timeoutMs: this.config.budget.episodeTimeoutMs,
        parent: input.parent, checks: input.checks,
        reserve: payload => {
          controller.signal.throwIfAborted()
          const ticket = this.budget.request(scope, episode, 'probe', payload)
          if (!ticket.ok) throw fail(ticket.reason)
          cost.calls++; cost.inputBytes += ticket.size
          return { settle: (outcome, usage) => this.budget.settle(ticket.callId, outcome, usage) }
        },
      })
      this.store.addEvidence(episode, 'probe', execution.transcript || execution.reason || '')
      if (!execution.ok) {
        return this.finish(episode, { state: 'failed', reason: execution.reason ?? 'probe_failed', cost })
      }

      // ---- checks ($, deterministic) --------------------------------------
      const checks = execution.checks
      if (input.checks?.length && (!checks || checks.length !== input.checks.length)) throw fail('missing_candidate_checks')
      if (checks) this.store.addEvidence(episode, 'checks', JSON.stringify(checks))
      controller.signal.throwIfAborted()
      if (!execution.metrics.complete) throw fail('probe_incomplete')

      // ---- decide (free) --------------------------------------------------
      const decision = decide({
        structure,
        baseMetrics: input.metrics,
        nextMetrics: execution.metrics,
        checks,
        taxDelta,
        cooldown: { ok: true, have: 0, need: 0 },
      })
      if (!decision.adopt) {
        return this.finish(episode, { state: 'rejected', reason: decision.reasons.join(' | '), detail: decision, cost, metrics: execution.metrics })
      }

      // ---- shadow adoption (free) -----------------------------------------
      toRev = this.store.putRev(scope, next, { parent: current.rev, state: 'shadow', reason: `episode:${episode}`, taxes: structure.tax })
      this.store.setRevState(current.rev, 'stable')
      this.store.openWatch(toRev, scope, input.taskKey, execution.metrics, this.config.budget.shadowWindow)
      this.store.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(`adoptAt:${scope}`, String(turnCounter(this.store, scope).get()))
      this.store.log({ rev: toRev, scope, action: 'shadow', actor: 'evolve', gate: { decision },
        detail: { episode, target: diagnosis.target, tax: structure.tax, taxDelta, metrics: execution.metrics } })
      state = 'shadow'
      reason = decision.reasons.join(' | ') || 'adopted'
      return this.finish(episode, { state, reason, toRev, cost, detail: decision })
    } catch (error) {
      reason = error?.code ?? 'internal'
      // A scope violation attempted by the editor is a rejection by the structure gate,
      // not an internal failure: the distinction is what makes the ledger readable.
      if (['off_target', 'invalid_path', 'not_managed', 'escape', 'too_large', 'read_limit'].includes(reason)) {
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
    const scope = this.store.db.prepare('SELECT scope FROM episode WHERE id=?').get(episode)?.scope
    this.store.log({ rev: toRev, scope, action: `episode_${state}`, actor: 'evolve', gate: detail, detail: { reason, metrics } })
    return { episode, state, reason, rev: toRev, cost, detail }
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
  observe({ scope, taskKey, corrections, toolErrors, complete }) {
    if (!this.enabled()) return []
    const decisions = fold(this.store, { scope, taskKey, corrections, toolErrors, complete })
    for (const decision of decisions) settle(this.store, decision.rev, decision.verdict, scope)
    return decisions
  }

  rollback(scope, rev) {
    const target = rev ?? (() => {
      const current = this.store.latest(scope, ['shadow', 'stable'])
      return current?.parent ?? null
    })()
    if (!target) return { ok: false, reason: 'no_parent' }
    return rollbackTo(this.store, scope, target)
  }

  status(scope, { files } = {}) {
    const current = this.current(scope)
    const report = current ? sizeReport(current.files) : (files ? sizeReport(files) : null)
    return {
      enabled: this.enabled(),
      route: this.config.enabled ? { provider: this.config.provider, model: this.config.model } : null,
      current: current ? { rev: current.rev, state: current.state, tax: taxOf(current.files) } : null,
      fixedTax: report ? { bytes: report.tax, cap: MAX_TAX_BYTES, components: report.rows } : null,
      budget: this.budget.report(scope),
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
