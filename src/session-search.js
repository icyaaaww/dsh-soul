import { bounded, terms as termSet } from './util.js'

/**
 * Retrieval over the live session's own history.
 *
 * The checkpoint should not have to carry details: the details are still in the event log, and
 * a plugin can address that log in-process through `session.surface.nodes` + `eventAt(seq)`.
 * This module is the "dereference" half of indexed memory — cheap, exact, and auditable,
 * with no embedding and no model call.
 */

const MAX_SCAN = 12000
const MAX_SPAN_BYTES = 1200
const MAX_TOTAL_BYTES = 4000

/** Extract the human-readable text of one session event, defensively across event shapes. */
export function textOfEvent(event) {
  const data = event?.data
  const content = data?.message?.content ?? data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block?.text === 'string') return block.text
      if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        return block.content.map(inner => typeof inner?.text === 'string' ? inner.text : '').join('\n')
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  return typeof data?.text === 'string' ? data.text : ''
}

const harvestCache = new WeakMap()

/**
 * Walk the live surface and collect addressable spans.
 *
 * Cached per session and invalidated by surface length: a tool called mid-turn should not
 * re-extract a megabyte of history on every query, but it must never serve a stale surface.
 */
export function harvest(session) {
  if (typeof session?.eventAt !== 'function') return []
  const total = Number(session.seq ?? session.log?.length ?? 0)
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : null
  const useLog = Number.isInteger(total) && total > 0
  const order = useLog
    ? Array.from({ length: Math.min(total, MAX_SCAN) }, (_, i) => Math.max(0, total - MAX_SCAN) + i)
    : nodes ?? []
  if (!order.length) return []

  const key = useLog ? `log:${total}` : `surface:${order.length}:${order[order.length - 1]}`
  const cached = harvestCache.get(session)
  if (cached && cached.key === key) return cached.spans

  const spans = []
  for (const seq of order) {
    const event = session.eventAt(seq)
    if (!event) continue
    const text = textOfEvent(event).trim()
    if (!text) continue
    spans.push({ seq, type: String(event.type ?? ''), text, terms: [...new Set(termSet(text))] })
  }
  harvestCache.set(session, { key, spans })
  return spans
}

/** Sparse idf over the span collection: a term found everywhere says nothing. */
function weightTerms(spans) {
  const frequency = new Map()
  for (const span of spans) for (const term of span.terms ?? new Set(termSet(span.text))) {
    frequency.set(term, (frequency.get(term) ?? 0) + 1)
  }
  return term => Math.log2(1 + spans.length / (1 + (frequency.get(term) ?? 1)))
}

/** Grow a byte-bounded slice around [from, to) so the matched literal is never cut off. */
function sliceAround(text, from, to, limit) {
  let start = from
  let end = to
  let bytes = Buffer.byteLength(text.slice(from, to))
  while (bytes < limit) {
    let grew = false
    if (end < text.length) {
      const size = Buffer.byteLength(text[end])
      if (bytes + size <= limit) { bytes += size; end++; grew = true }
    }
    if (start > 0) {
      const size = Buffer.byteLength(text[start - 1])
      if (bytes + size <= limit) { bytes += size; start--; grew = true }
    }
    if (!grew) break
  }
  return text.slice(start, end)
}

/** The densest window of a long span, so a 40 KB tool result yields its load-bearing line. */
export function densestWindow(text, limit, needles) {
  if (Buffer.byteLength(text) <= limit) return text
  // Size the window in characters from the text's own byte-per-character ratio: a fixed
  // character count would overrun the byte budget by three times on Chinese prose.
  // A literal hit is the common case and the cheap one: centre on it instead of scoring windows.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at >= 0) return sliceAround(text, at, at + needle.length, limit)
  }
  const bytesPerChar = Math.max(1, Buffer.byteLength(text) / Math.max(1, text.length))
  const width = Math.max(32, Math.floor(limit / bytesPerChar))
  const starts = []
  const stride = Math.max(16, Math.floor(width / 4))
  for (let start = 0; start + width <= text.length; start += stride) starts.push(start)
  // The tail needs its own window: a needle in the last `width` characters is otherwise never
  // scored, which is exactly where logs put their summary line.
  if (text.length > width) starts.push(text.length - width)
  let best = { score: -1, start: 0 }
  for (const start of starts) {
    const slice = text.slice(start, start + width)
    let score = 0
    for (const needle of needles) if (slice.includes(needle)) score += needle.length
    if (score > best.score) best = { score, start }
  }
  const window = text.slice(best.start, best.start + width)
  return best.score <= 0 ? bounded(text, limit) : bounded(window, limit)
}

/**
 * Rank spans against a query and return a few of them, bounded in bytes.
 *
 * @returns {{spans: Array<{seq:number,type:string,score:number,text:string}>, scanned:number, bytes:number}}
 */
export function searchSpans(spans, query, { limit = 3, maxSpanBytes = MAX_SPAN_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const queryTerms = termSet(query)
  if (!spans.length || !queryTerms.length) return { spans: [], scanned: spans.length, bytes: 0 }
  const idf = weightTerms(spans)
  const needleList = String(query ?? '').toLowerCase().split(/\s+/).filter(token => token.length >= 2)

  const scored = []
  for (const span of spans) {
    const own = span.terms ? new Set(span.terms) : new Set(termSet(span.text))
    let score = 0
    for (const term of queryTerms) if (own.has(term)) score += idf(term)
    // An exact literal hit (a path, a code) outranks partial term overlap.
    const lower = span.text.toLowerCase()
    for (const needle of needleList) if (lower.includes(needle)) score += 2 * idf(needle)
    if (score > 0) scored.push({ span, score })
  }
  scored.sort((a, b) => b.score - a.score || b.span.seq - a.span.seq)

  const picked = []
  const usedSeqs = new Set()
  let bytes = 0
  for (const { span, score } of scored) {
    if (picked.length >= limit || bytes >= maxTotalBytes) break
    if (usedSeqs.has(span.seq)) continue
    const text = densestWindow(span.text, maxSpanBytes, needleList)
    const price = Buffer.byteLength(text)
    if (bytes + price > maxTotalBytes) continue
    picked.push({ seq: span.seq, type: span.type, score: Math.round(score * 100) / 100, text })
    usedSeqs.add(span.seq)
    bytes += price
  }
  return { spans: picked, scanned: spans.length, bytes }
}

/**
 * Convenience: search the live session directly.
 * Returns a note instead of throwing when the host exposes no addressable surface.
 */
export function searchSession(session, query, options) {
  const spans = harvest(session)
  if (!spans.length) return { spans: [], scanned: 0, bytes: 0, note: '会话没有可检索的原文' }
  return searchSpans(spans, query, options)
}

/**
 * Read one addressable range verbatim.
 *
 * This is the other half of a directory card: the card says `[97-210]`, this returns exactly
 * those events, bounded, so a pointer costs one call and a known number of bytes.
 */
export function expandRange(session, from, to, { limit = 2000, maxEvents = 200 } = {}) {
  const start = Math.max(0, Math.min(Number(from) || 0, Number(to) || 0))
  const end = Math.max(Number(from) || 0, Number(to) || 0)
  if (typeof session?.eventAt !== 'function') return { from: start, to: end, bytes: 0, text: '', events: 0 }
  const parts = []
  let events = 0
  for (let seq = start; seq <= end && events < maxEvents; seq++) {
    const event = session.eventAt(seq)
    if (!event) continue
    const text = textOfEvent(event).trim()
    if (!text) continue
    parts.push(text)
    events++
  }
  const text = bounded(parts.join('\n'), limit)
  return { from: start, to: end, bytes: Buffer.byteLength(text), text, events }
}
