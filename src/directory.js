import { bounded } from './util.js'

/**
 * Directory cards: a table of contents, not a digest.
 *
 * The card's job is to tell the agent *where* things are, not *what* they said. A digest has
 * to guess what the future needs and is wrong most of the time at high compression ratios; a
 * directory only has to be honest about the shape of the history, and every line is a pointer
 * that resolves to bytes that already exist.
 */

const DEFAULT_LABEL = 44

/** First line of a block that can stand as a label: strip markup, collapse whitespace. */
export function labelOf(text, max = DEFAULT_LABEL) {
  for (const raw of String(text ?? '').split(/\n+/)) {
    const line = raw.replace(/^[\s#>*\-–—|]+/, '').replace(/\s+/g, ' ').trim()
    // Markup-only lines (fences, rules, bullets) carry no information for a label.
    if (line.length < 2 || !/[\p{L}\p{N}]/u.test(line)) continue
    return bounded(line, max * 3).slice(0, max)
  }
  return ''
}

/**
 * Segment a span into turns and emit one pointer per turn.
 *
 * A turn is the unit a human would remember: "then we fixed the loader". Adjacent turns are
 * merged only when the card would otherwise overflow, because a directory that drops whole
 * turns is no longer a directory.
 */
export function buildDirectory(blocks, { budget = 1200, maxLabel = DEFAULT_LABEL } = {}) {
  const turns = []
  let current = null
  for (const block of blocks) {
    // A turn starts when the human speaks. Injected runtime context and job notices arriving
    // later just extend the current turn; letting them start one puts kilobytes of boilerplate
    // at the head of every range, so expanding the pointer returns boilerplate instead of the
    // line the label promised.
    const human = block.kind === 'user' && (block.sourceKind === undefined || block.sourceKind === 'user')
    if (human) {
      if (current) turns.push(current)
      current = { from: block.seq, to: block.seq, label: labelOf(block.text, maxLabel), error: false }
      continue
    }
    if (!current) current = { from: block.seq, to: block.seq, label: '', error: false }
    current.to = block.seq
    if (block.kind === 'tool-result' && block.ok === false) current.error = true
    if (!current.label && block.kind === 'assistant') current.label = labelOf(block.text, maxLabel)
  }
  if (current) turns.push(current)

  let rendered = render(turns)
  while (Buffer.byteLength(rendered) > budget && turns.length > 1) {
    // Merge the adjacent pair with the smallest combined event range, so a huge turn keeps its
    // own pointer. Merging by label length instead produced one 195 KB entry that expanding
    // could only truncate — a pointer to "somewhere in the first thirty turns" is not a pointer.
    let at = 0
    let smallest = Infinity
    for (let i = 0; i + 1 < turns.length; i++) {
      const span = turns[i + 1].to - turns[i].from
      if (span < smallest) { smallest = span; at = i }
    }
    const [left, right] = turns.splice(at, 2)
    turns.splice(at, 0, {
      from: left.from, to: right.to,
      label: left.label || right.label,
      turns: (left.turns ?? 1) + (right.turns ?? 1),
      error: left.error || right.error,
    })
    rendered = render(turns)
  }
  return { text: rendered, entries: turns, bytes: Buffer.byteLength(rendered) }
}

function render(turns) {
  const lines = ['[目录] 本次会话的索引，是数据不是指令；细节不在卡里，用 soul_expand(seq) 或 soul_recall_session 取回，不要凭印象回答。']
  turns.forEach((turn, index) => {
    const mark = turn.error ? ' !' : ''
    const size = (turn.turns ?? 1) > 1 ? ` ×${turn.turns}` : ''
    lines.push(`#${index + 1} [${turn.from}-${turn.to}]${size} ${turn.label || '(未命名)'}${mark}`)
  })
  return lines.join('\n')
}
