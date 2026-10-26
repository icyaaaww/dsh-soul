/**
 * Shadow adoption.
 *
 * Trial versions affect real traffic. Silence is not a correctness verdict; only
 * explicit artifact verification drains the window. Negative observations can
 * still reject immediately. Repeated trials are not a proof of generalization.
 *
 * Tier ordering is absolute: a user correction outranks any offline evidence.
 */

export const VERDICTS = new Set(['pass', 'fail', 'pending'])

/** Decide what a shadow window observed. Pure, so the rule is testable in isolation. */
export function verdictOf(window, { corrections = 0, toolErrors = 0, complete = true, verified = false } = {}) {
  if (corrections > 0) return 'fail'
  if (!complete) return 'fail'
  const base = window?.baseline ?? { toolErrors: 0 }
  if (toolErrors > base.toolErrors) return 'fail'
  return window?.remaining > 0 || !verified ? 'pending' : 'pass'
}

/**
 * Fold one observed turn into every open shadow window for the scope.
 *
 * @returns {{rev:string, verdict:string}[]} decisions reached by this turn
 */
export function fold(store, { scope, taskKey, corrections, toolErrors, complete, verified = false }) {
  const decisions = []
  for (const window of store.openWatches(scope)) {
    if (window.verdict) continue
    // Only same-kind tasks count toward the window: an unrelated task says nothing about
    // whether this edit helped, and counting it would let the window close on noise.
    if (window.task_key !== taskKey && window.remaining > 0) continue
    const after = corrections > 0 || toolErrors > 0 || !complete || !verified
      ? window : store.consumeWatch(window.rev) ?? window
    const verdict = verdictOf(after, { corrections, toolErrors, complete, verified })
    if (verdict === 'pending') continue
    store.decideWatch(window.rev, verdict)
    decisions.push({ rev: window.rev, verdict })
  }
  return decisions
}

/** Promote/rollback a revision according to the window verdict. */
export function settle(store, rev, verdict, scope, actor = 'watch') {
  if (verdict === 'pass') {
    store.setRevState(rev, 'stable')
    store.log({ rev, scope, action: 'promote', actor, gate: { window: 'pass' },
      detail: '影子窗口通过，转为 stable' })
    return { promoted: rev }
  }
  const row = store.rev(rev, scope)
  if (!row) return { rolledBack: null }
  store.setRevState(rev, 'retired')
  store.log({ rev, scope, action: 'rollback', actor, gate: { window: 'fail' },
    detail: { reason: '影子窗口内出现负反馈' } })
  if (row.parent) store.setRevState(row.parent, 'stable')
  return { rolledBack: rev, restored: row.parent ?? null }
}

/**
 * Manual rollback to any revision in the chain. Used by /evolve rollback.
 * The target is re-validated against its own parent so a rollback cannot install a tree
 * that the gate would have rejected.
 */
export function rollbackTo(store, scope, revId, actor = 'user') {
  const row = store.rev(revId, scope)
  if (!row) return { ok: false, reason: 'rev_not_found' }
  for (const open of store.openWatches(scope)) store.decideWatch(open.rev, 'fail')
  const current = store.latest(scope, ['stable', 'shadow'])
  if (current && current.id !== revId) store.setRevState(current.id, 'retired')
  store.setRevState(revId, 'stable')
  store.log({ rev: revId, scope, action: 'rollback', actor, gate: null,
    detail: { from: current?.id ?? null, to: revId } })
  return { ok: true, rev: revId, from: current?.id ?? null }
}
