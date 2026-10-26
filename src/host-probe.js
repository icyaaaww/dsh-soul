import { fail } from './util.js'
import { join } from 'node:path'
import { withWorktree, installTree, repoOf, prefixOf, isClean, runChecks } from './probe.js'

/**
 * Real-host probe: run the candidate harness against an actual DSH subagent session inside a
 * throwaway git worktree.
 *
 * The host surface is injected (`spawn`) rather than assumed, because the subagent API is a
 * host detail: the orchestrator should not depend on it directly, and tests can drive a
 * deterministic stand-in.
 */
export function hostProbe({ spawn, capability, provider, model, reasoningEffort = '', steps = 40 }) {
  if (typeof spawn !== 'function') throw fail('no_spawner', '未提供宿主子会话执行器')

  const execute = async ({ files, task, root, signal, parent, reserve, checks = [], harnessFolder = '.dsh-soul/harness' }) => {
    const repo = root ? await repoOf(root) : null
    if (!repo) {
      throw fail('not_a_repo', '候选探测需要干净的 git 仓库')
    }

    const prefix = await prefixOf(root)
    // Separate checkout, not a security sandbox; host permissions still govern tools.
    return withWorktree(repo, async folder => {
      const cwd = join(folder, ...prefix.split('/'))
      await installTree(cwd, files, { folder: harnessFolder })
      const result = await spawn({
        cwd, task, signal, parent, files, reserve,
        harnessFolder,
        provider, model, reasoningEffort,
        maxSteps: steps,
        // The candidate tree is loaded through the same injection point the live plugin uses,
        // so what is measured is the harness, not a simulation of it.
      })
      signal.throwIfAborted()
      const checked = checks.length ? await runChecks(cwd, checks, { signal }) : null
      const complete = result?.complete === true
      return {
        metrics: {
          toolErrors: result.toolErrors,
          toolCalls: result.toolCalls,
          steps: result.steps,
          complete,
          deliverable: complete && !!checked?.length && checked.every(c => c.ok),
          durationMs: Number(result?.durationMs ?? 0),
        },
        transcript: String(result?.transcript ?? ''),
        checks: checked,
      }
    })
  }
  execute.supportedTargets = ['C1', 'C2', 'C3', 'C4']
  execute.preflight = async ({ cwd, parent }) => {
    if (!parent) throw fail('parent_unavailable')
    const available = capability?.(parent)
    if (available && !available.ok) throw fail(available.reason)
    const repo = cwd && await repoOf(cwd)
    if (!repo) throw fail('not_a_repo')
    if (!(await isClean(repo))) throw fail('dirty_worktree')
    return repo
  }
  return execute
}
