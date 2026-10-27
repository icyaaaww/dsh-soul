import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../harness/default/', import.meta.url))

export function defaults() {
  const files = {}
  for (const name of ['system.md', 'guardrails.md', 'memory.md', 'tools.md', 'subagents.md']) {
    files[name] = readFileSync(dir + name, 'utf8')
  }
  return files
}

/**
 * Deterministic stand-in for the editor model. Records every request so tests can assert
 * what the prompt did and did not contain.
 */
export function fixtureEditor(script = {}) {
  const requests = []
  let inflight = 0, maxInflight = 0
  return {
    requests,
    maxInflight: () => maxInflight,
    generate: async ({ system, data, phase }) => {
      requests.push({ phase, system, data })
      inflight++; maxInflight = Math.max(maxInflight, inflight)
      try {
        if (phase !== 'edit') throw new Error(`unexpected phase ${phase}`)
        if (script.steps) return { actions: script.steps.shift() ?? [{ type: 'finish', why: 'no more' }] }
        const target = data.index.target.path
        const body = script.body ?? 'edited body'
        return { actions: [{ type: 'write', path: `harness/${target}`, text: body }, { type: 'finish', why: script.why ?? 'reduced repeated tool error' }] }
      } finally { inflight-- }
    },
  }
}

/** Deterministic probe executor: reports whatever metrics the test asks for. */
export function fixtureExecutor(metrics = {}) {
  const calls = []
  return {
    calls,
    execute: async ctx => {
      calls.push({ task: ctx.task, arm: ctx.arm, maxSteps: ctx.maxSteps, files: Object.keys(ctx.files) })
      return { metrics: { toolErrors: 0, toolCalls: 5, steps: 3, complete: true, deliverable: true, durationMs: 1, ...metrics }, transcript: 'fixture probe', verification: 'fixture-snapshot', checks: ctx.checks.map(c => ({name: c.name, ok: ctx.arm !== 'baseline'})) }
    },
  }
}

export const BASE_METRICS = { toolErrors: 2, toolCalls: 9, steps: 5, complete: true, deliverable: true, durationMs: 1000 }

export function divergence(signals = [{ kind: 'tool_error', weight: 3, detail: 'timeout on Bash' }]) {
  return { signals, score: signals.reduce((n, s) => n + s.weight, 0) }
}
