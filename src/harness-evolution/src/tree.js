import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { hash, bytes, bounded } from './util.js'

/**
 * The eight editable harness components (Xu et al. 2026, Table 5), mapped to DSH mechanisms.
 *
 * `tax: true` means the component is injected on every model call, so its size is part of the
 * per-turn fixed cost T. Skills/scripts/hooks cost nothing until invoked, which is why the
 * design prefers moving knowledge into them (axiom 7).
 */
export const COMPONENTS = {
  C1: { path: 'system.md', name: '系统提示', tax: true, cap: 2000, anchor: true, activation: '每次调用' },
  C2: { path: 'guardrails.md', name: '护栏', tax: true, cap: 1200, anchor: true, activation: '每次调用' },
  C3: { path: 'memory.md', name: '记忆策略', tax: true, cap: 800, anchor: false, activation: '每次调用' },
  C4: { path: 'tools.md', name: '工具指引', tax: true, cap: 1200, anchor: false, activation: '每次调用' },
  C5: { path: 'subagents.md', name: '子代理', tax: false, cap: 3000, anchor: false, activation: '被委派时' },
  C6: { path: 'skills', name: '技能', tax: false, cap: 8000, anchor: false, activation: '被调用时', dir: true },
  C7: { path: 'scripts', name: '脚本', tax: false, cap: 16000, anchor: false, activation: '被运行时', dir: true },
  // A hook is code, not prose: its structural contract is the required fail-open/timeout
  // exports enforced by lint(), not an HTML anchor block inside a .mjs file.
  C8: { path: 'hooks', name: 'hook', tax: false, cap: 6000, anchor: false, activation: '工具循环内', dir: true },
}

export const TAX_TARGETS = Object.entries(COMPONENTS).filter(([, c]) => c.tax).map(([k]) => k)
export const targets = () => Object.keys(COMPONENTS)
export const componentOf = path => Object.entries(COMPONENTS).find(([, c]) => c.dir ? path === c.path || path.startsWith(`${c.path}/`) : path === c.path)?.[0]

/**
 * Total per-turn fixed cost, in bytes. Only every-call components count.
 * Accepts either a {path: text} tree (live files) or a {path: {bytes}} metadata map, so the
 * same function serves the gate, the status report and the persisted revision row.
 */
export function taxOf(tree) {
  let total = 0
  for (const key of TAX_TARGETS) {
    const path = COMPONENTS[key].path
    const entry = tree[path]
    if (entry === undefined || entry === null) continue
    total += typeof entry === 'string' ? bytes(entry) : (entry.bytes ?? 0)
  }
  return total
}

// ---------------------------------------------------------------------------
// Path safety. The harness root is the only directory this plugin ever writes.
// ---------------------------------------------------------------------------

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

export function safePath(path) {
  if (typeof path !== 'string' || !path) throw Object.assign(new Error('组件路径为空'), { code: 'invalid_path' })
  if (!SAFE_PATH.test(path)) throw Object.assign(new Error(`组件路径含非法字符: ${path}`), { code: 'invalid_path' })
  const parts = path.split('/')
  if (parts.some(p => p === '..' || p === '.' || p === '')) {
    throw Object.assign(new Error(`组件路径含越界片段: ${path}`), { code: 'invalid_path' })
  }
  if (!componentOf(path)) throw Object.assign(new Error(`组件不在受管白名单内: ${path}`), { code: 'not_managed' })
  return path
}

export function inRoot(root, path) {
  const base = resolve(root)
  const target = resolve(join(root, ...path.split('/')))
  if (target !== base && !target.startsWith(base + sep)) {
    throw Object.assign(new Error(`路径逃出 harness 根目录: ${path}`), { code: 'escape' })
  }
  return target
}

// ---------------------------------------------------------------------------
// Anchor blocks. Everything between the markers is byte-frozen at adoption time,
// so "editable system prompt" cannot become "editable permissions".
// ---------------------------------------------------------------------------

const ANCHOR_BEGIN = '<!-- ANCHOR:BEGIN -->'
const ANCHOR_END = '<!-- ANCHOR:END -->'

export function anchorsOf(text) {
  const out = []
  let from = 0
  for (;;) {
    const start = text.indexOf(ANCHOR_BEGIN, from)
    if (start < 0) break
    const end = text.indexOf(ANCHOR_END, start)
    if (end < 0) throw Object.assign(new Error('锚定区未闭合'), { code: 'anchor_unclosed' })
    out.push(text.slice(start + ANCHOR_BEGIN.length, end))
    from = end + ANCHOR_END.length
  }
  return out
}

/**
 * Anchors must be present where required and identical to the baseline.
 * Comparison is on the anchor bodies only, and also on their count, so an
 * editor cannot delete a constraint by deleting its anchor block.
 */
export function checkAnchors(path, baseText, nextText) {
  const required = COMPONENTS[componentOf(path)]?.anchor
  const base = anchorsOf(baseText ?? '')
  const next = anchorsOf(nextText ?? '')
  // Removing an existing anchor is tampering, not "starting fresh": report the more precise
  // code so the ledger distinguishes an attempted deletion from a malformed new file.
  if (base.length && !next.length) {
    throw Object.assign(new Error(`${path} 的锚定区被删除`), { code: 'anchor_tampered' })
  }
  if (required && !next.length) {
    throw Object.assign(new Error(`${path} 必须有锚定区`), { code: 'anchor_missing' })
  }
  if (base.length !== next.length) {
    throw Object.assign(new Error(`${path} 锚定区数量被改变（${base.length} → ${next.length}）`), { code: 'anchor_tampered' })
  }
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== next[i]) {
      throw Object.assign(new Error(`${path} 第 ${i + 1} 个锚定区内容被修改`), { code: 'anchor_tampered' })
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic lint. Only structural, checkable properties are enforced here;
// semantic "is this really a fact vs a procedure" classification is the editor's
// job and is NOT pretended to be automatic.
// ---------------------------------------------------------------------------

const BANNED = [
  { re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instruction/i, why: '试图覆盖上层指令' },
  { re: /(?:你没有|忽略)(?:任何)?(?:权限|限制)|bypass\s+(?:the\s+)?(?:sandbox|permission)/i, why: '试图解除权限约束' },
  { re: /-----BEGIN [^-]*PRIVATE KEY-----/, why: '含私钥' },
  { re: /\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}/, why: '含凭据' },
]

const HOOK_REQUIRED = [
  { re: /export\s+const\s+timeoutMs\s*=/, why: 'hook 必须声明 timeoutMs' },
  { re: /export\s+const\s+failOpen\s*=\s*true/, why: 'hook 必须声明 failOpen = true（失败即放行）' },
  { re: /export\s+(?:default\s+)?(?:async\s+)?function\s+run|export\s+const\s+run\s*=/, why: 'hook 必须导出 run' },
]
const HOOK_FORBIDDEN = [
  { re: /node:(?:net|http|https|dgram|tls|dns)/, why: 'hook 禁止网络访问' },
  { re: /(?:process\.env|~\/\.ssh|\.aws|credentials)/, why: 'hook 禁止读取凭据与环境' },
  { re: /child_process/, why: 'hook 禁止派生子进程' },
  { re: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;/, why: 'hook 禁止无界循环' },
]

/**
 * @returns {string[]} violations; empty means the component is structurally valid.
 */
export function lint(path, text, { tree, blob } = {}) {
  const key = componentOf(path)
  const spec = COMPONENTS[key]
  const problems = []
  if (!spec) return [`未知组件: ${path}`]
  if (typeof text !== 'string' || !text.trim()) return [`${path} 为空`]

  const size = bytes(text)
  if (size > spec.cap) problems.push(`${path} 超出组件上限 ${spec.cap} 字节（当前 ${size}）`)

  for (const rule of BANNED) if (rule.re.test(text)) problems.push(`${path} ${rule.why}`)

  if (key === 'C8') {
    if (!path.endsWith('.mjs')) problems.push(`${path} hook 必须是 .mjs`)
    for (const rule of HOOK_REQUIRED) if (!rule.re.test(text)) problems.push(`${path} ${rule.why}`)
    for (const rule of HOOK_FORBIDDEN) if (rule.re.test(text)) problems.push(`${path} ${rule.why}`)
  }
  if (key === 'C7' && !path.endsWith('.mjs')) problems.push(`${path} 脚本必须是 .mjs`)

  if (spec.anchor) {
    try { if (!anchorsOf(text).length) problems.push(`${path} 缺少锚定区`) }
    catch (error) { problems.push(`${path} ${error.message}`) }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Tree snapshots. A tree maps managed relative paths to content hashes, so a
// refactor of any component produces a new root id and an exact diff.
// ---------------------------------------------------------------------------

const WALK_SKIP = new Set(['.git', 'node_modules'])

/** Read a tree from disk, returning {path: text}. */
export function readTree(root) {
  const files = {}
  const walk = (rel) => {
    const abs = inRoot(root, rel)
    let stat
    try { stat = lstatSync(abs) } catch { return }
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`拒绝读取符号链接: ${rel}`), { code: 'symlink' })
    if (stat.isDirectory()) {
      if (WALK_SKIP.has(rel.split('/').pop())) return
      for (const name of readdirSync(abs)) walk(rel ? `${rel}/${name}` : name)
      return
    }
    if (!stat.isFile()) return
    safePath(rel)
    files[rel] = readFileSync(abs, 'utf8')
  }
  for (const [, spec] of Object.entries(COMPONENTS)) walk(spec.path)
  return files
}

/** Deterministic root id for a {path: text} tree. */
export function treeId(files) {
  const canon = Object.keys(files).sort().map(path => [path, hash(files[path])])
  return hash(JSON.stringify(canon))
}

/** Compact per-file diff for evidence. Bounded so it cannot dominate a prompt. */
export function diffTrees(base, next, { maxLines = 400, maxBytes = 12000 } = {}) {
  const added = [], removed = [], changed = []
  for (const path of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (base[path] === undefined) { added.push(path); continue }
    if (next[path] === undefined) { removed.push(path); continue }
    if (base[path] !== next[path]) changed.push(path)
  }
  const hunks = []
  for (const path of changed) {
    const a = base[path].split('\n'), b = next[path].split('\n')
    const lines = []
    // Simple LCS-free prefix/suffix trim: enough for a reviewable evidence diff.
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
    for (let i = pre; i < a.length - suf && lines.length < maxLines; i++) lines.push(`-${a[i]}`)
    for (let i = pre; i < b.length - suf && lines.length < maxLines; i++) lines.push(`+${b[i]}`)
    hunks.push({ path, at: Math.min(pre + 1, a.length + 1), lines })
  }
  return { added, removed, changed, hunks, text: bounded(JSON.stringify({ added, removed, changed, hunks }), maxBytes) }
}

/** Per-component byte report used by /evolve status and the fixed-tax budget. */
export function sizeReport(files) {
  const rows = {}
  for (const [key, spec] of Object.entries(COMPONENTS)) {
    const paths = Object.keys(files).filter(p => componentOf(p) === key)
    rows[key] = { name: spec.name, activation: spec.activation, tax: spec.tax, cap: spec.cap,
      bytes: paths.reduce((n, p) => n + bytes(files[p]), 0), files: paths.length }
  }
  return { rows, tax: TAX_TARGETS.reduce((n, k) => n + rows[k].bytes, 0) }
}
