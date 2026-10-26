import { readFileSync, mkdirSync, writeFileSync, existsSync, cpSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sizeReport } from './tree.js'

const DEFAULT_DIR = fileURLToPath(new URL('../harness/default/', import.meta.url))

/** Where a project's harness lives. One tree per project, never global. */
export const harnessRoot = cwd => join(cwd, '.dsh-soul', 'harness')

/**
 * Seed a project's harness from the shipped defaults, without ever clobbering user edits.
 * Returns whether anything was created, so callers can log a meaningful first-run event.
 */
export function ensureHarness(cwd) {
  const root = harnessRoot(cwd)
  if (existsSync(join(root, 'system.md'))) return { root, created: false }
  mkdirSync(root, { recursive: true })
  cpSync(DEFAULT_DIR, root, { recursive: true, force: false })
  return { root, created: true }
}

export function readDefaults() {
  const files = {}
  for (const name of ['system.md', 'guardrails.md', 'memory.md', 'tools.md', 'subagents.md']) {
    files[name] = readFileSync(join(DEFAULT_DIR, name), 'utf8')
  }
  return files
}

/**
 * Write a tree to disk for human review. Temp file then rename, so a reader never observes a
 * half-written component -- the harness is injected into live prompts from these files.
 */
export function writeHarness(cwd, files) {
  const root = ensureHarness(cwd).root
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    const temp = `${target}.tmp`
    writeFileSync(temp, text, 'utf8')
    try { renameSync(temp, target) } catch { writeFileSync(target, text, 'utf8'); try { unlinkSync(temp) } catch { /* gone */ } }
  }
  return root
}

export { sizeReport }
