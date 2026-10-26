import { mkdtemp, rm, mkdir, writeFile, lstat, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { bounded, fail, redact } from './util.js'
import { emptyMetrics } from './gate.js'
import { safePath } from './tree.js'

const run = promisify(execFile)

/**
 * Candidate execution.
 *
 * The reference execution is NOT re-run: the real trajectory the agent already produced is
 * the baseline. Only the candidate tree is executed, which halves the cost of a comparison
 * relative to a naive A/B replay.
 *
 * Execution uses a separate git checkout. Host tool permissions remain in force:
 * a worktree is not a filesystem or network security sandbox.
 */

/** Locate the repository root of a project scope, or null when it is not a git repo. */
export async function repoOf(cwd) {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 8000 })
    return stdout.trim() || null
  } catch { return null }
}

/** True when the working tree has no uncommitted changes (required for a truthful replay). */
export async function isClean(root) {
  try {
    const { stdout } = await run('git', ['-C', root, 'status', '--porcelain'], { timeout: 8000 })
    return !stdout.trim()
  } catch { return false }
}

/**
 * Create a throwaway worktree pinned at HEAD. Caller must call `release`.
 * Using a detached worktree means the probe sees exactly the committed state.
 */
export async function withWorktree(root, fn) {
  if (!(await isClean(root))) throw fail('dirty_worktree', '工作区有未提交改动，回放会产生噪声；已跳过离线探测')
  const folder = await mkdtemp(join(tmpdir(), 'dsh-soul-harness-probe-'))
  let added = false, primary
  try {
    await run('git', ['-C', root, 'worktree', 'add', '--detach', folder, 'HEAD'], { timeout: 30000 })
    added = true
    return await fn(folder)
  } catch (error) {
    primary = error; throw error
  } finally {
    let cleanup
    if (added) {
      try { await run('git', ['-C', root, 'worktree', 'remove', '--force', folder], { timeout: 30000 }) }
      catch (error) { cleanup = error }
    }
    try { await rm(folder, { recursive: true, force: true }) } catch (error) { cleanup ??= error }
    if (cleanup) {
      if (primary) primary.cleanup = 'worktree_cleanup_failed'
      else throw fail('worktree_cleanup_failed', '临时 worktree 清理失败，请检查 git worktree list')
    }
  }
}

/**
 * Materialise a harness tree into a project so it can be loaded by the probe agent.
 * Only the managed component paths are written; nothing else in the project is touched.
 */
export async function installTree(root, files, { folder = '.dsh-soul/harness' } = {}) {
  if (typeof folder !== 'string' || isAbsolute(folder) || /[:\0]/.test(folder) || folder.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw fail('invalid_path')
  const base = join(root, ...folder.split('/'))
  if (!resolve(base).startsWith(resolve(root) + sep)) throw fail('escape')
  const noLinks = async target => {
    let cursor = resolve(target)
    for (;;) {
      const info = await lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (info?.isSymbolicLink()) throw fail('symlink', '拒绝经过符号链接写入 harness')
      if (cursor === resolve(root)) break
      const parent = dirname(cursor)
      if (cursor === parent) throw fail('escape')
      cursor = parent
    }
  }
  for (const path of Object.keys(files)) { safePath(path); await noLinks(join(base, ...path.split('/'))) }
  for (const [path, text] of Object.entries(files)) {
    const target = join(base, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.evolve-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
  }
  return base
}

/**
 * A layer: deterministic project checks declared by the user.
 * User-declared commands run without a shell, with timeout and bounded output.
 * They have normal process privileges; their project test files are not immutable.
 */
export async function runChecks(root, checks, { timeoutMs = 120000, signal } = {}) {
  const results = []
  for (const check of checks) {
    signal?.throwIfAborted()
    const started = Date.now()
    try {
      const [cmd, ...args] = check.argv
      const { stdout, stderr } = await run(cmd, args, { cwd: root, timeout: timeoutMs, maxBuffer: 1 << 20, signal, windowsHide: true })
      results.push({ name: check.name, ok: true, ms: Date.now() - started, output: bounded(redact(`${stdout}${stderr}`), 1200) })
    } catch (error) {
      signal?.throwIfAborted()
      results.push({
        name: check.name, ok: false, ms: Date.now() - started,
        output: bounded(redact(`${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`), 1200),
      })
    }
  }
  return results
}

/**
 * Execute one probe: hand the candidate tree and the task to an injected executor.
 * The executor is injected so the orchestrator, not this module, decides whether the real
 * DSH subagent session or a deterministic fixture performs the work.
 *
 * @param {(ctx: object) => Promise<{metrics: object, transcript: string}>} execute
 */
export async function probe({ execute, files, task, harnessFolder, signal, timeoutMs = 480000, root = null, parent, reserve, checks }) {
  if (typeof execute !== 'function') throw fail('no_executor', '未配置探测执行器')
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(fail('probe_timeout')), timeoutMs)
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const result = await execute({ files, task, harnessFolder, root, signal: merged, parent, reserve, checks })
    merged.throwIfAborted()
    if (!result?.metrics || !['steps','toolCalls','toolErrors','durationMs'].every(k => Number.isFinite(result.metrics[k]) && result.metrics[k] >= 0) || typeof result.metrics.complete !== 'boolean') throw fail('invalid_probe_metrics')
    const metrics = { ...emptyMetrics(), ...(result?.metrics ?? {}) }
    metrics.durationMs = metrics.durationMs || Date.now() - started
    return { ok: true, metrics, checks: result.checks ?? null, transcript: bounded(redact(result?.transcript ?? ''), 12000) }
  } catch (error) {
    if (merged.aborted) {
      const reason = merged.reason?.code ?? 'probe_timeout'
      return { ok: false, metrics: { ...emptyMetrics(), complete: false }, transcript: '', reason }
    }
    return { ok: false, metrics: { ...emptyMetrics(), complete: false }, transcript: bounded(redact(error.message), 1200), reason: error.code ?? 'probe_failed' }
  } finally {
    clearTimeout(timer)
  }
}
