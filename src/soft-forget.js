const DAY = 86_400_000
const MIN_AGE_MS = 30 * DAY
const MIN_IDLE_MS = 30 * DAY
const BATCH_LIMIT = 25

/**
 * Retire a small batch of cold, standalone progress notes in one project.
 *
 * This is opt-in: nothing calls it from capture or retrieval. It only changes node.state, so
 * ordinary recall/history paths can still find retired rows. `seen` is stamped at retirement
 * and restoration, making it the persisted start of the 30-day grace period.
 */
export function softForget(store, scope, { now = store.now() } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp')

  return store.tx(() => {
    const candidates = store.db.prepare(`SELECT n.id FROM node n
      WHERE n.scope=? AND n.state='active' AND n.valid_to IS NULL
        AND n.kind='progress' AND n.pin=0 AND n.salience=0
        AND n.hits=0 AND n.created<=? AND n.seen<=?
        AND NOT EXISTS (SELECT 1 FROM activation a WHERE a.scope=n.scope AND a.node=n.id)
        AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.scope=n.scope AND (e.src=n.id OR e.dst=n.id))
      ORDER BY n.seen ASC, n.created ASC, n.id ASC LIMIT ?`).all(
      scope, now - MIN_AGE_MS, now - MIN_IDLE_MS, BATCH_LIMIT,
    )
    if (!candidates.length) return []

    const retire = store.db.prepare(`UPDATE node SET state='retired', seen=?
      WHERE id=? AND scope=? AND state='active' AND valid_to IS NULL`)
    const retired = []
    for (const { id } of candidates) {
      if (retire.run(now, id, scope).changes) retired.push(id)
    }
    return retired
  })
}
