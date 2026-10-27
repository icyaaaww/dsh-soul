import { fail, hash } from './util.js'
import { join } from 'node:path'
import { withWorktree, installTree, repoOf, isClean, runChecks } from './probe.js'
import { captureReplay, assertVerifier } from './validation.js'

/**
 * Real-host probe: run the candidate harness against an actual DSH subagent session inside a
 * throwaway git worktree.
 *
 * The host surface is injected (`spawn`) rather than assumed, because the subagent API is a
 * host detail: the orchestrator should not depend on it directly, and tests can drive a
 * deterministic stand-in.
 */
export function hostProbe({ spawn, capability, provider, model, reasoningEffort = '', steps = 40, components }) {
  if (typeof spawn !== 'function') throw fail('no_spawner', '未提供宿主子会话执行器')

  const execute = async ({ files, task, root, signal, maxSteps, parent, reserve, checks = [], harnessFolder = '.dsh-soul/harness', replay }) => {
    const repo = root ? await repoOf(root) : null
    if (!repo) {
      throw fail('not_a_repo', '候选探测需要干净的 git 仓库')
    }

    replay ??= await captureReplay(root, checks)
    if (replay.repo !== repo) throw fail('replay_repo_mismatch')
    const prefix = replay.prefix
    // Separate checkout, not a security sandbox; host permissions still govern tools.
    return withWorktree(repo, async folder => {
      const cwd = join(folder, ...prefix.split('/'))
      await assertVerifier(cwd, replay)
      await installTree(cwd, files, { folder: harnessFolder })
      const release = components?.lease(cwd, files)
      try {
        const result = await spawn({
          cwd, task, signal, parent, files, reserve, harnessFolder,
          provider, model, reasoningEffort, maxSteps: maxSteps ?? steps,
        })
        signal.throwIfAborted()
        await assertVerifier(cwd, replay)
        const checked = await runChecks(cwd, replay.checks, { signal })
        await assertVerifier(cwd, replay)
        const complete = result?.complete === true
        return {
          metrics: {
            toolErrors: result.toolErrors, toolCalls: result.toolCalls, steps: result.steps, complete,
            deliverable: complete && !!checked?.length && checked.every(c => c.ok),
            durationMs: Number(result?.durationMs ?? 0), tokens: result.tokens ?? null,
          },
          transcript: String(result?.transcript ?? ''), checks: checked,
          verification: hash(JSON.stringify({ replay: replay.identity, task, provider, model, reasoningEffort })),
        }
      } finally { release?.() }
    }, { revision: replay.revision })
  }
  execute.supportedTargets = components?.supportedTargets ?? ['C1', 'C2', 'C3', 'C4']
  execute.preflight = async ({ cwd, parent, checks }) => {
    if (!parent) throw fail('parent_unavailable')
    const available = capability?.(parent)
    if (available && !available.ok) throw fail(available.reason)
    const repo = cwd && await repoOf(cwd)
    if (!repo) throw fail('not_a_repo')
    if (!(await isClean(repo))) throw fail('dirty_worktree')
    return captureReplay(cwd, checks)
  }
  return execute
}
