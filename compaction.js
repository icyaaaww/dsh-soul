import { createSkeletonEngine } from './src/compaction.js'

/**
 * Graph compaction backend.
 *
 * Mounted *alongside* this package, not through it: DSH allows exactly one `ctx.compaction`
 * per context, so this entry replaces `@deepseek-ai/dsh-compaction-basic` rather than
 * augmenting it. The base class is imported at load time because the host owns replay, the
 * durable lock and surface replacement, and none of that is reimplemented here.
 */

export const name = 'dsh-soul-compaction'

let Base
try {
  ;({ BasicCompactionEngine: Base } = await import('@deepseek-ai/dsh-compaction-basic'))
} catch (error) {
  throw new Error(
    'dsh-soul/compaction 需要宿主提供 @deepseek-ai/dsh-compaction-basic；' +
    '请确认 DSH 版本包含压缩后端，或改回挂载默认后端。原始错误：' + (error?.message ?? error),
  )
}

export default createSkeletonEngine(Base)
