import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

export const hash = value => createHash('sha256').update(String(value)).digest('hex')
export const id = () => randomUUID()
export function bounded(text, bytes = 4000) {
  const buf = Buffer.from(String(text ?? ''))
  if (buf.length <= bytes) return buf.toString()
  return buf.subarray(0, bytes).toString().replace(/\uFFFD$/u, '')
}
export function redact(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/g, '[REDACTED TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret|sessdata|authorization|cookie)\s*[=:]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
}
export function clean(text, bytes = 4000) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('需要非空文字')
  return bounded(redact(text.trim()), bytes)
}
export function terms(text) {
  const s = String(text).normalize('NFKC').toLowerCase()
  const words = s.match(/[a-z0-9_]{2,}/g) ?? []
  for (const span of s.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (span.length === 1) words.push(span)
    else for (let i = 0; i < span.length - 1; i++) words.push(span.slice(i, i + 2))
  }
  return [...new Set(words)].slice(0, 80)
}
export function projectScope(session) {
  const cwd = session?.header?.cwd
  if (!cwd || !isAbsolute(cwd)) return `session:${session?.id ?? 'unknown'}`
  let path = resolve(cwd)
  try { path = realpathSync.native(path) } catch { /* Preserve a non-existing session path. */ }
  if (process.platform === 'win32') path = path.toLowerCase()
  return `project:${hash(path)}`
}
export function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  return bounded(content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n'), 6000)
}
export const human = message => message?.source?.kind === 'user'
export const day = time => new Date(time).toISOString().slice(0, 10)
export function integer(value, fallback, min, max) {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`配置值必须为 ${min}–${max} 的整数`)
  return n
}
