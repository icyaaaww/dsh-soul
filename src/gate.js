import { bytes, fail } from './util.js'
import { COMPONENTS, anchorsOf, checkAnchors, componentOf, lint, taxOf, sizeReport, safePath } from './tree.js'
import { assertTarget } from './diagnose.js'
import { compareTrials } from './validation.js'

/**
 * The gate is where "the model proposed something" becomes "something may happen".
 *
 * It is entirely deterministic: no model is consulted, and no gate can be argued with.
 * Tests assert each rejection path, because a gate that only exists in prose is not a gate.
 */

export const MAX_TAX_BYTES = 2400

/** Structural validation of a candidate tree against its parent. */
export function checkStructure({ target, base, next, allowUnchanged = false }) {
  const violations = []
  const changed = []
  for (const [path,text] of Object.entries(next)) {
    try { safePath(path); violations.push(...lint(path,text)) } catch (e) { violations.push(e.message) }
  }

  for (const path of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (base[path] === next[path]) continue
    changed.push(path)
    try { assertTarget(target, path) }
    catch (error) { violations.push(error.message); continue }
    const component = componentOf(path)
    if (!component) { violations.push(`未受管路径: ${path}`); continue }

    if (next[path] !== undefined) {
      try { checkAnchors(path, base[path] ?? defaultAnchorFor(component, base), next[path]) }
      catch (error) { violations.push(error.message) }
    } else if (COMPONENTS[component].anchor) {
      violations.push(`不得删除受锚定组件: ${path}`)
    }
    if (component === target) continue
    // Non-target components may only be touched if the target is a directory component
    // that physically contains them; anything else is an unattributable second edit.
    if (!contains(target, path)) violations.push(`越界编辑：目标 ${target} 但改动了 ${path}`)
    else violations.push(`跨组件编辑：${path} 不属于单一目标 ${target}`)
  }

  if (!changed.length && !allowUnchanged) violations.push('没有任何改动')
  if (Object.keys(next).filter(p=>componentOf(p)==='C8').length > 4) violations.push('最多激活 4 个 hook，避免每次工具执行累计延迟')

  const tax = taxOf(next)
  if (tax > MAX_TAX_BYTES) violations.push(`每轮固定税 ${tax} 字节超出上限 ${MAX_TAX_BYTES}`)

  for (const [key, spec] of Object.entries(COMPONENTS)) {
    const total = Object.keys(next).filter(p => componentOf(p) === key).reduce((n, p) => n + bytes(next[p]), 0)
    if (total > spec.cap) violations.push(`${key} 组件总量 ${total} 超上限 ${spec.cap}`)
  }

  return { ok: violations.length === 0, violations, changed, tax, report: sizeReport(next) }
}

const contains = (target, path) => {
  const spec = COMPONENTS[target]
  return !!spec && (path === spec.path || path.startsWith(`${spec.path}/`))
}

function defaultAnchorFor(component, base) {
  const spec = COMPONENTS[component]
  if (!spec.anchor) return ''
  // A newly created anchored component must still carry the same anchors as its siblings;
  // if the parent never had it, there is no baseline to preserve, so require the anchor to
  // come from the reference `<component>.anchor` file when present.
  const anchorPath = Object.keys(base).find(p => p === `${spec.path}.anchor`)
  return anchorPath ? base[anchorPath] : ''
}

// ---------------------------------------------------------------------------
// A/B layer comparison. C layer (model judgement) never reaches this function:
// it can only send a candidate to shadow, never to stable.
// ---------------------------------------------------------------------------

/** B-layer metric vector extracted from a probe run. */
export const emptyMetrics = () => ({ toolErrors: 0, toolCalls: 0, steps: 0, complete: true, deliverable: false, durationMs: 0 })

export function compareMetrics(base, next) {
  const regressions = [], improvements = []
  if (next.toolErrors > base.toolErrors) regressions.push(`工具错误 ${base.toolErrors} → ${next.toolErrors}`)
  if (next.complete === false && base.complete !== false) regressions.push('运行未完成')
  if (base.deliverable && !next.deliverable) regressions.push('丢失交付物')

  if (next.toolErrors < base.toolErrors) improvements.push(`工具错误 ${base.toolErrors} → ${next.toolErrors}`)
  if (next.deliverable && !base.deliverable) improvements.push('新产生交付物')
  if (next.complete && base.complete === false) improvements.push('运行恢复完整')
  // Step/call reduction only counts when correctness signals did not regress, mirroring
  // the design rule: quality first, efficiency never wins alone.
  if (!regressions.length && next.toolCalls < base.toolCalls) improvements.push(`工具调用 ${base.toolCalls} → ${next.toolCalls}`)
  if (!regressions.length && next.steps < base.steps) improvements.push(`步数 ${base.steps} → ${next.steps}`)

  return { regressions, improvements }
}

/**
 * Adoption decision. Written as data, not as prose, so it cannot drift from the code.
 *
 * @returns {{adopt:boolean, shadow:boolean, violations:string[], reasons:string[]}}
 */
export function decide({ structure, pairs, validation, cooldown }) {
  if (!structure.ok) return { adopt: false, shadow: false, violations: structure.violations, reasons: ['结构校验失败'] }
  const evidence = compareTrials(pairs, validation)
  if (!evidence.ok) return { adopt: false, shadow: false, violations: [], reasons: [evidence.reason], evidence }
  if (cooldown && !cooldown.ok) return { adopt: false, shadow: false, violations: [], reasons: ['cooldown'] }
  return { adopt: true, shadow: true, violations: [], reasons: [evidence.reason], evidence }
}

/** Rolling turn counter used for the cooldown, persisted in meta so restarts do not reset it. */
export function turnCounter(store, scope) {
  const key = `turns:${scope}`
  return {
    get: () => Number(store.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? 0),
    bump: () => store.db.prepare(`INSERT INTO meta(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`).run(key),
  }
}

export { fail, anchorsOf }
