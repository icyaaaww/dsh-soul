import { bounded, clean, hash, redact, taskKey, textBlocks, human, day } from './util.js'

/**
 * Turn-level observation. This is the "free baseline" source: every trajectory the agent
 * already produced is kept as evidence, so a refinement episode never pays to re-run the
 * reference. Only the candidate is ever executed.
 */

/** B-layer metrics: deterministic, cheap, and comparable across turns. */
export const EMPTY_METRICS = Object.freeze({
  steps: 0, toolCalls: 0, toolErrors: 0, durationMs: 0,
  deliverable: false, complete: true, corrections: 0, reason: 'unknown',
})

/**
 * A turn in progress. Kept in memory only: a crash mid-turn costs one observation,
 * which is cheaper than a reconciliation pass over a half-written table.
 */
export class Recorder {
  constructor() {
    this.turns = new Map()
  }

  start(sessionId, { scope, turn, intent }) {
    const state = {
      session: sessionId, scope, turn, intent,
      taskKey: taskKey({ scope, text: intent }),
      text: bounded(intent, 2000),
      steps: 0, toolCalls: 0, toolErrors: 0, started: Date.now(),
      calls: new Map(), tools: [], errors: [], deliverable: false,
      complete: true, finished: null, corrections: 0,
    }
    this.turns.set(sessionId, state)
    return state
  }

  get(sessionId) { return this.turns.get(sessionId) ?? null }

  end(sessionId) {
    const state = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    if (!state) return null
    state.finished = Date.now()
    state.durationMs = state.finished - state.started
    // A turn that ended with an outstanding tool call is not a clean observation.
    if ([...state.calls.values()].some(c => !c.done)) state.complete = false
    return state
  }

  observe(sessionId, type, data = {}) {
    const state = this.get(sessionId)
    if (!state) return
    if (type === 'step/start') state.steps++
    if (type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      state.calls.set(data.callId, { name: clean(data.name, 120), done: false })
      if (!state.tools.includes(data.name)) state.tools.push(data.name)
    }
    if (type === 'tool/result') {
      const callId = data.message?.toolCallId
      const call = callId ? state.calls.get(callId) : null
      if (!call || call.done) return
      call.done = true
      // Harness-observation tools are not independent evidence of task success.
      if (call.name.startsWith('evolve_')) return
      state.toolCalls++
      if (data.message?.isError) {
        state.toolErrors++
        const text = bounded(redact(textBlocks(data.message?.content) || ''), 600)
        if (text) state.errors.push({ tool: call.name, text })
      }
    }
    if (type === 'turn/end' && data.reason?.kind) {
      state.reason = String(data.reason.kind)
      if (!['completed', 'stop'].includes(state.reason)) state.complete = false
    }
  }

  /**
   * A user correction after the previous turn is the strongest signal available (Tier D).
   * Counting it on the *next* turn keeps the current turn's metrics immutable.
   */
  markCorrection(sessionId) {
    const state = this.get(sessionId)
    if (state) state.corrections++
  }
}

const CORRECTION = /不对|错了|不是这个|重新|再试试|没改对|又错|还是不行|别这样|说过|之前提过|wrong|not what|again|still broken|redo|that's not/i

export function isCorrection(text) {
  return CORRECTION.test(String(text ?? ''))
}

/** Signals that a turn is worth turning into an episode at all. */
export function divergenceOf(state) {
  const signals = []
  if (state.toolErrors > 0) signals.push({ kind: 'tool_error', weight: 3, detail: state.errors.slice(0, 3) })
  if (state.corrections > 0) signals.push({ kind: 'user_correction', weight: 4, detail: bounded(state.text, 300) })
  if (!state.complete) signals.push({ kind: 'incomplete', weight: 2, detail: state.reason })
  if (state.reason === 'max-tokens') signals.push({ kind: 'truncated', weight: 2, detail: 'max-tokens' })
  if (!state.deliverable && state.toolCalls > 0 && state.reason === 'stop') {
    signals.push({ kind: 'no_deliverable', weight: 1, detail: 'turn stopped without a concrete result' })
  }
  if (!signals.length) return null
  // Strongest first: diagnosis takes the head as "the earliest divergence worth fixing", and
  // a caller should not have to re-sort to get that.
  const ordered = [...signals].sort((a, b) => b.weight - a.weight)
  return { signals: ordered, score: ordered.reduce((n, s) => n + s.weight, 0) }
}

/**
 * Repetition is the entry condition for evolution (design axiom: never evolve a one-off).
 * We count how many times the same task fingerprint showed a divergence in the window.
 */
export function repeatCount(rows, taskKeyValue, windowMs = 7 * 86400000) {
  const cutoff = Date.now() - windowMs
  return rows.filter(r => r.task_key === taskKeyValue && r.created >= cutoff && r.state !== 'skipped').length
}

/** Serialise a trajectory for evidence; bounded so it cannot dominate a prompt. */
export function trajectoryText(state, { maxBytes = 10000 } = {}) {
  return bounded(JSON.stringify({
    intent: bounded(state.text, 600),
    steps: state.steps, toolCalls: state.toolCalls, toolErrors: state.toolErrors,
    complete: state.complete, reason: state.reason, durationMs: state.durationMs,
    tools: state.tools.slice(0, 24),
    errors: state.errors.slice(0, 6),
  }, null, 2), maxBytes)
}
