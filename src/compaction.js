import { existsSync } from 'node:fs'
import { bounded, projectScope } from './util.js'
import { buildDirectory } from './directory.js'
import { compact, extract, normalize } from './skeleton.js'
import { Store } from './store.js'

/**
 * Read-only access to the knowledge graph for compression.
 *
 * The compressor is a separate plugin from the memory plugin, so the two hand off through one
 * environment variable rather than a shared service. Without the database the backend still
 * compacts — it just loses the graph weighting.
 */
let sharedStore = null
function graphStore() {
  const file = process.env.DSH_SOUL_DATABASE
  if (!file || !existsSync(file)) return null
  try { sharedStore ??= new Store(file); return sharedStore } catch { return null }
}

/**
 * Map seq -> selection multiplier from edge connectivity.
 *
 * A claim that many other claims hang off is worth more than its word count suggests. The cap
 * keeps a single hub from monopolising the budget.
 */
export function graphBoost(agent) {
  const store = graphStore()
  const cwd = agent?.session?.header?.cwd
  if (!store || !cwd) return null
  try {
    const scope = projectScope({ id: agent.session.id, header: { cwd } })
    const nodes = store.activeNodes(scope, 400)
    if (!nodes.length) return null
    const weight = new Map()
    for (const row of store.edgeWeights(scope)) {
      weight.set(row.src, (weight.get(row.src) ?? 0) + row.w)
      weight.set(row.dst, (weight.get(row.dst) ?? 0) + row.w)
    }
    const boost = new Map()
    for (const node of nodes) {
      const value = (weight.get(node.id) ?? 0) + (node.pin ? 3 : 0)
      if (value > 0) boost.set(node.seq, 1 + Math.min(value, 4) * 0.25)
    }
    return boost.size ? boost : null
  } catch { return null }
}

/**
 * Graph compaction backend (1.6).
 *
 * `@deepseek-ai/dsh-compaction-basic` documents one subclass hook: `summarize(input, agent,
 * signal)` decides what text replaces the condensed span; replay, the durable lock, surface
 * replacement and checkpoint framing all stay fixed. This module overrides exactly that hook
 * and answers with a graph-selected skeleton instead of a model-written summary.
 *
 * The consequence is measurable and slightly absurd: replacing the summarizer removes the
 * summarizer call. Compaction becomes a pure function of the span, so it cannot be biased by
 * adversarial content inside the conversation — the failure mode that lets an injected
 * message argue itself into the summary.
 */

/** Keep a fifth of the span, bounded. Small spans still get a usable card; huge ones stay cheap. */
export const BUDGET_RATIO = 0.2
export const MIN_BUDGET_BYTES = 600
export const MAX_BUDGET_BYTES = 3000

const textOfBlock = block => {
  if (typeof block === 'string') return block
  if (Array.isArray(block?.content)) {
    return block.content.filter(item => item?.type === 'text').map(item => String(item.text ?? '')).join('\n')
  }
  if (typeof block?.content === 'string') return block.content
  if (typeof block?.text === 'string') return block.text
  return ''
}

/**
 * Map LLM conversation messages onto the surface events the normalizer understands.
 *
 * The two vocabularies differ: a conversation carries `role` plus content blocks, while the
 * session carries typed events. Doing the mapping here keeps `skeleton.normalize` the only
 * place that decides what a block is.
 */
export function fromConversation(messages = []) {
  const events = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
    const texts = content.filter(block => block?.type === 'text')
    const calls = content.filter(block => block?.type === 'tool-call')
    const results = content.filter(block => block?.type === 'tool-result')

    if (message.role === 'assistant') {
      if (texts.length) events.push({ type: 'assistant/message', data: { message: { content: texts } } })
      if (calls.length) events.push({ type: 'assistant/message', data: { message: { content: calls } } })
      continue
    }
    // A tool result arrives as a user-role message; emit it before any prose in the same turn
    // so the normalizer pairs it with the call that precedes it.
    if (results.length) {
      events.push({
        type: 'tool/result',
        data: {
          content: results.map(block => ({ type: 'text', text: bounded(textOfBlock(block), 4000) })),
          isError: Boolean(results[0]?.isError ?? results[0]?.is_error),
        },
      })
    }
    // Carry the source through: without it a runtime-context message looks like the human and
    // its boilerplate gets pinned as a standing constraint.
    if (texts.length) events.push({ type: 'user/message', data: { message: { content: texts }, source: message.source } })
  }
  return events
}

/** Size the card from the span itself: no configuration, no per-project tuning. */
export function spanBytes(input) {
  return (input?.messages ?? []).reduce((sum, message) =>
    sum + Buffer.byteLength(JSON.stringify(message?.content ?? '')), 0)
}

export function budgetFor(input) {
  return Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, Math.floor(spanBytes(input) * BUDGET_RATIO)))
}

/** The host frames every checkpoint with a preamble, so a very short span cannot shrink. */
export const MIN_COMPACTABLE_SPAN_BYTES = 1200

/**
 * The summarizer override. Returns the exact envelope `compactSurfaceRegion` expects from a
 * backend: text-only summary blocks, the raw output, and the absence of an LLM call.
 *
 * It must beat the shadowed span, or the host rejects the commit. The fixed checkpoint
 * framing is paid by the caller, not by this card, so a span smaller than the framing can
 * never shrink — failing loudly there is better than committing a checkpoint that grew.
 */
export function skeletonSummarize(input, { mode = 'directory', budget = budgetFor(input), boost = null } = {}) {
  const span = spanBytes(input)
  if (span < MIN_COMPACTABLE_SPAN_BYTES) {
    throw new Error(`跨度仅 ${span} bytes，小于可压缩下限 ${MIN_COMPACTABLE_SPAN_BYTES}（checkpoint 固定开销所致）`)
  }
  const ceiling = Math.floor(span * 0.45)
  const events = fromConversation(input?.messages ?? [])
  const limit = Math.min(budget, ceiling)
  // A directory is the default: it never claims to know what the future needs, and every line
  // resolves to bytes that already exist. The skeleton remains the fallback for spans too short
  // to segment into turns.
  let text = ''
  if (mode === 'directory') {
    const blocks = normalize(events)
    // Constraints are the one thing a directory cannot carry, so they ride above it.
    const pinned = extract(blocks, { scope: 'compaction' }).nodes.filter(node => node.pin).slice(0, 3)
    const pinnedText = pinned.map(node => `- 约束: ${bounded(node.claim, 72)}`).join('\n')
    const pinnedBytes = Buffer.byteLength(pinnedText)
    const directory = buildDirectory(blocks, { budget: Math.max(200, limit - pinnedBytes - 1) })
    if (directory.entries.length >= 2) text = [pinnedText, directory.text].filter(Boolean).join('\n')
  }
  if (!text) text = compact({ events, budget: limit, scope: 'compaction', boost }).text.trim()
  if (!text) throw new Error('跨度没有可提炼的结构，放弃压缩而不是提交一个空 checkpoint')
  if (Buffer.byteLength(text) > ceiling) {
    throw new Error(`骨架 ${Buffer.byteLength(text)} bytes 超过跨度的 45%（${ceiling}），放弃压缩`)
  }
  const summary = [{ type: 'text', text }]
  return {
    summary,
    rawOutput: summary,
    llmStreamCall: false,
    provider: '',
    model: '',
    maxTokens: 0,
  }
}

/**
 * Build the backend class from whatever base the host provides.
 *
 * Passing the base in (instead of importing it) keeps this module loadable — and testable —
 * without the host package present.
 */
export function createSkeletonEngine(Base) {
  if (typeof Base !== 'function') throw new Error('createSkeletonEngine 需要一个 CompactionEngine 基类')
  return class SkeletonCompactionEngine extends Base {
    // The base class owns configuration, the durable lock, replay and surface replacement.
    // Only `summarize` is ours.
    constructor(ctx, config = {}) { super(ctx, config) }

    async summarize(input, agent, signal) {
      signal?.throwIfAborted?.()
      if (!Array.isArray(input?.messages) || !input.messages.length) {
        throw new Error('compaction 需要可重放的消息前缀')
      }
      const result = skeletonSummarize(input, { budget: budgetFor(input), boost: graphBoost(agent) })
      // Re-check after building: a cancellation between selection and return must not produce
      // a checkpoint that the caller then aborts halfway through writing.
      signal?.throwIfAborted?.()
      return result
    }
  }
}
