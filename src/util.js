import { createHash, randomUUID } from 'node:crypto'

export const hash = value => createHash('sha256').update(String(value)).digest('hex')
export const id = () => randomUUID()
export const now = () => Date.now()

/** Byte-bound a string without splitting a surrogate pair. */
export function bounded(text, bytes = 4000) {
  const buf = Buffer.from(String(text ?? ''))
  if (buf.length <= bytes) return buf.toString()
  return buf.subarray(0, bytes).toString().replace(/�$/u, '')
}

export const bytes = text => Buffer.byteLength(String(text ?? ''))

/**
 * Strip credential-shaped substrings before anything reaches disk or a model prompt.
 * This is a denylist, not a guarantee: callers must still avoid putting secrets in evidence.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{12,}/g, '[REDACTED TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret|sessdata|authorization|cookie)\s*[=:]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
}

export function clean(text, limit = 4000) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('需要非空文字')
  return bounded(redact(text.trim()), limit)
}

/** Validate an integer setting with an explicit range instead of silently clamping. */
export function integer(value, fallback, min, max, name) {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name ?? '配置值'} 必须是 ${min}–${max} 的整数`)
  }
  return n
}

export function boolean(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`)
  return value
}

/** UTC day key; budgets are calendar-day scoped so a restart cannot reset them. */
export const day = time => new Date(time).toISOString().slice(0, 10)

/**
 * Task fingerprint: the identity of "the same kind of work".
 * Deliberately coarse -- two tasks match when they share a project, a tool
 * sequence shape and the leading intent words. Coarse matching is what makes
 * "this keeps happening" observable at all; it is not a semantic classifier.
 */
export function taskKey({ scope, text, tools = [] }) {
  const intent = leadingIntent(text)
  return hash([scope, intent, tools.join('>')].join('\u0000'))
}

const STOP = new Set(['的', '了', '是', '在', '我', '你', '把', '给', '和', '与', '就', '都', '也', '请', '帮', '一下',
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'in', 'on', 'is', 'it', 'this', 'that', 'please', 'can', 'you'])

/** Reduce a user request to a coarse action+object signature. */
export function leadingIntent(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  const words = []
  for (const word of s.match(/[a-z0-9_]{2,}/g) ?? []) if (!STOP.has(word)) words.push(word)
  for (const span of s.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let i = 0; i < span.length - 1 && words.length < 40; i++) {
      const pair = span.slice(i, i + 2)
      if (!STOP.has(pair)) words.push(pair)
    }
  }
  return [...new Set(words)].slice(0, 6).join(',')
}

export function terms(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  const words = s.match(/[a-z0-9_]{2,}/g) ?? []
  for (const span of s.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (span.length === 1) words.push(span)
    else for (let i = 0; i < span.length - 1; i++) words.push(span.slice(i, i + 2))
  }
  return [...new Set(words)].slice(0, 80)
}

/** Project scope: one harness tree per project, keyed by resolved cwd. */
export function projectScope(session) {
  const cwd = session?.header?.cwd
  if (!cwd || !isAbsolutePath(cwd)) return `session:${session?.id ?? 'unknown'}`
  return `project:${hash(normalizePath(cwd))}`
}

function isAbsolutePath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

function normalizePath(p) {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

export const human = message => message?.source?.kind === 'user'

export function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  return bounded(content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n'), 6000)
}

/** Structured failure with a machine-readable code. */
export const fail = (code, message = code) => Object.assign(new Error(message), { code })
