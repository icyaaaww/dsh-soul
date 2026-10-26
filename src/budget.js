import { day, bytes } from './util.js'

/**
 * Three-dimensional budget: calls, input bytes, wall clock.
 *
 * Every dimension is reserved inside one transaction BEFORE the request leaves the process.
 * Nothing is refunded: a failed, cancelled or timed-out request already consumed provider
 * capacity, and pretending otherwise is how a "budget" turns into a lie.
 *
 * Episode-scoped dimensions are keyed by episode id so one episode cannot spend another's
 * allowance; daily dimensions are keyed by scope and UTC day so a restart cannot reset them.
 */
export function budgetSettings(input = {}) {
  const n = (key, fallback, min, max) => {
    const v = input[key] ?? fallback
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`)
    return v
  }
  return {
    episodeCalls: n('episodeCalls', 60, 4, 400),
    dailyCalls: n('dailyCalls', 100, 0, 2000),
    requestInputBytes: n('requestInputBytes', 24000, 2000, 96000),
    episodeInputBytes: n('episodeInputBytes', 320000, 8000, 3840000),
    dailyInputBytes: n('dailyInputBytes', 800000, 0, 9600000),
    episodeTimeoutMs: n('episodeTimeoutMs', 480000, 5000, 3600000),
    requestTimeoutMs: n('requestTimeoutMs', 60000, 500, 300000),
    probeSteps: n('probeSteps', 40, 1, 200),
    cooldownTurns: n('cooldownTurns', 20, 0, 500),
    shadowWindow: n('shadowWindow', 3, 1, 20),
    repeatThreshold: n('repeatThreshold', 3, 2, 20),
    repeatWindowMs: n('repeatWindowDays', 7, 1, 90) * 86400000,
  }
}

const EPISODE = 'ep'
const DAILY = 'day'
const EPISODE_IN = 'epIn'
const DAILY_IN = 'dayIn'

export class Budget {
  constructor(store, config, now = Date.now) {
    this.store = store
    this.config = config
    this.now = now
  }

  key(scope, episode, dim) {
    return `${scope}:${dim}:${dim === EPISODE || dim === EPISODE_IN ? episode : '*'}`.replace(':*', '')
  }

  /** Daily gate, checked before an episode is created. */
  canStart(scope) {
    const today = day(this.now())
    const state = this.store.budgetState(today, [this.key(scope, null, DAILY), this.key(scope, null, DAILY_IN)])
    if (state[this.key(scope, null, DAILY)].used >= this.config.dailyCalls) return { ok: false, reason: 'daily_budget' }
    if (state[this.key(scope, null, DAILY_IN)].used >= this.config.dailyInputBytes) return { ok: false, reason: 'daily_input_budget' }
    return { ok: true }
  }

  /**
   * Reserve one request against all four dimensions at once.
   * @returns {{ok:true, callId:string, size:number} | {ok:false, reason:string, size?:number}}
   */
  request(scope, episode, phase, payload) {
    const size = bytes(payload)
    if (size > this.config.requestInputBytes) {
      return { ok: false, reason: 'input_limit', size }
    }
    const today = day(this.now())
    const keys = {
      [EPISODE]: this.key(scope, episode, EPISODE),
      [DAILY]: this.key(scope, null, DAILY),
      [EPISODE_IN]: this.key(scope, episode, EPISODE_IN),
      [DAILY_IN]: this.key(scope, null, DAILY_IN),
    }
    const dims = {
      [keys[EPISODE]]: { limit: this.config.episodeCalls, amount: 1 },
      [keys[DAILY]]: { limit: this.config.dailyCalls, amount: 1 },
      [keys[EPISODE_IN]]: { limit: this.config.episodeInputBytes, amount: size },
      [keys[DAILY_IN]]: { limit: this.config.dailyInputBytes, amount: size },
    }
    const result = this.store.reserve({ day: today, dims, episode, phase, inputBytes: size })
    if (!result.ok) {
      const reason = result.key.includes(':epIn:') || result.key.includes(':dayIn:')
        ? (result.key.includes(':epIn:') ? 'input_budget' : 'daily_input_budget')
        : (result.key.includes(':ep:') ? 'episode_budget' : 'daily_budget')
      return { ok: false, reason, size }
    }
    return { ok: true, callId: result.callId, size }
  }

  settle(callId, outcome, usage) {
    this.store.settle(callId, outcome, usage)
  }

  report(scope, episode = null) {
    const today = day(this.now())
    const keys = [this.key(scope, null, DAILY), this.key(scope, null, DAILY_IN)]
    if (episode) keys.push(this.key(scope, episode, EPISODE), this.key(scope, episode, EPISODE_IN))
    const state = this.store.budgetState(today, keys)
    return {
      day: today,
      daily: {
        calls: state[keys[0]],
        inputBytes: state[keys[1]],
        limits: { calls: this.config.dailyCalls, inputBytes: this.config.dailyInputBytes },
      },
      ...(episode ? {
        episode: {
          calls: state[keys[2]],
          inputBytes: state[keys[3]],
          limits: { calls: this.config.episodeCalls, inputBytes: this.config.episodeInputBytes },
        },
      } : {}),
      byPhase: this.store.callStats(today),
      note: '额度在请求发出前预留，失败/取消/超时都计入；不重试已付费请求。字节不等于 token，也不是货币预算。',
    }
  }
}
