import { hash, terms as termSet } from './util.js'
import { densestWindow, textOfEvent } from './session-search.js'

/**
 * The addressable span index.
 *
 * Three properties matter and each is a fix for a measured failure:
 *  - incremental: only new events are ingested, so a turn costs what it appended, not the
 *    whole history (measured: 300 ms per turn at 9k events when re-harvested in full);
 *  - de-duplicated by content hash: a session repeats the same output dozens of times and
 *    those copies crowded the top of every result;
 *  - complete: the index lives on disk, so the silent 12k-event scan cap is gone.
 */

export const MAX_INGEST_PER_CALL = 4000

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/g

/**
 * Split CJK into single characters for the index.
 *
 * FTS5's tokenizer treats a run of Han characters as one token, so "反作弊为什么失效" is a
 * single opaque word and a two-character query can never match it. Indexing it as
 * " 反 作 弊 …" turns every character into a token, and phrase queries then behave like
 * substring search.
 */
const segment = text => String(text ?? '')
  .replace(CJK, ch => ` ${ch} `)
  .replace(/\s+/g, ' ')
  .trim()

/** A term as an FTS phrase, so a Chinese bigram requires adjacent characters. */
const phrase = term => `"${String(term).replace(CJK, ch => ` ${ch} `).replaceAll('"', '').replace(/\s+/g, ' ').trim()}"`

/**
 * Bring the index up to date, catching up in batches until done or the time budget runs out.
 *
 * A single bounded batch left a 37k-event session ten calls behind, which is indistinguishable
 * from the old scan cap: the earliest history simply was not there. Looping under a deadline
 * keeps one search bounded in time without leaving a permanent gap.
 */
export function ingest(store, scope, session, { max = MAX_INGEST_PER_CALL, budgetMs = 250 } = {}) {
  const sessionId = String(session?.id ?? 'default')
  const total = Number(session?.seq ?? 0)
  if (!(total > 0)) return { added: 0, watermark: store.spanWatermark(scope, sessionId), total: 0, remaining: 0, session: sessionId }

  const started = performance.now()
  let added = 0
  let watermark = store.spanWatermark(scope, sessionId)
  let remaining = 0

  for (;;) {
    const from = Math.max(0, watermark + 1)
    if (from >= total) break
    const to = Math.min(total - 1, from + max - 1)
    const rows = []
    for (let seq = from; seq <= to; seq++) {
      const event = session.eventAt(seq)
      if (!event) continue
      const text = textOfEvent(event).trim()
      if (!text) continue
      rows.push({ seq, kind: String(event.type ?? ''), text, indexText: segment(text), hash: hash(text) })
    }
    added += store.putSpans(scope, sessionId, rows)
    store.setSpanWatermark(scope, sessionId, to)
    watermark = to
    remaining = Math.max(0, total - 1 - to)
    if (!remaining || performance.now() - started >= budgetMs) break
  }
  return { added, watermark, total, remaining, session: sessionId }
}

/**
 * Search the index and return a bounded set of spans.
 *
 * FTS5 first (bm25 ranking), substring second for queries the tokenizer cannot express —
 * a Windows path is one "word" to FTS and a literal to LIKE.
 */
export function searchIndex(store, scope, query, { limit = 3, maxBytes = 4000, maxSpanBytes = 1200, sessionId = null } = {}) {
  const coverage = store.spanCoverage(scope)
  const terms = termSet(query)
  if (!terms.length || !coverage.spans) return { spans: [], bytes: 0, coverage }

  const match = terms.slice(0, 12).map(phrase).join(' OR ')
  let rows = []
  try { rows = store.searchSpans(scope, match, limit * 4) } catch { rows = [] }
  if (!rows.length) rows = store.findSpans(scope, String(query ?? '').trim(), limit * 2)

  const needles = String(query ?? '').toLowerCase().split(/\s+/).filter(token => token.length >= 2)
  const spans = []
  let bytes = 0
  for (const row of rows) {
    if (spans.length >= limit || bytes >= maxBytes) break
    const text = densestWindow(String(row.text ?? ''), maxSpanBytes, needles)
    const price = Buffer.byteLength(text)
    if (bytes + price > maxBytes) continue
    spans.push({
      seq: row.seq,
      // A hit from an earlier session is labelled as such: the model must know it cannot
      // expand it, only read what is quoted here.
      session: row.session ?? null,
      current: sessionId === null ? true : row.session === sessionId,
      score: Math.round((Number(row.score) || 0) * 1000) / 1000,
      text,
    })
    bytes += price
  }
  return { spans, bytes, coverage }
}
