import { randomUUID } from 'node:crypto'
import { bounded, fail, textBlocks } from './util.js'
import { Recorder } from './observe.js'

// DSH 0.2.1 public seam: local spawn activations, caller-owned result and disposal.
// Register the exact child identity BEFORE startup: its first request may precede publication.
export function createHostRunner(ctx, { backend = 'spawn', requestTimeoutMs = 60000 } = {}) {
  const get = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  const pending = new Map(), recorder = new Recorder(), disposers = []
  const capability = parent => {
    const service = get('subagents'), agents = get('agents'), provider = service?.getProvider?.(backend)
    if (typeof service?.startActivation !== 'function' || typeof agents?.currentInitiator !== 'function') return { ok: false, reason: 'host_runner_unavailable' }
    if (!provider?.prepareContinuable || provider.inheritsParentContext !== false || !provider.capabilities?.agentOptions) return { ok: false, reason: 'local_spawn_unavailable' }
    if (parent && agents.get(parent.id) !== parent) return { ok: false, reason: 'parent_unavailable' }
    return { ok: true, backend, api: 'subagents.startActivation', supportedTargets: ['C1', 'C2', 'C3', 'C4'] }
  }
  for (const [path, order] of [['system.md', 900], ['guardrails.md', 910], ['tools.md', 920], ['memory.md', 950]]) {
    disposers.push(ctx.systemPrompt.context({ name: `dsh-soul:probe:${path}`, order, interpolate: false,
      text: ({ agent }) => pending.get(String(agent?.id))?.files[path] ?? '' }))
  }
  disposers.push(ctx.on('session/event', (session, event) => {
    const state = pending.get(String(session.id)); if (!state) return
    recorder.observe(String(session.id), event.type, event.data)
    if (event.type === 'turn/end') { state.metrics = recorder.end(String(session.id)); state.ended = true }
  }))
  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    const agent = get('agents')?.currentInitiator(), state = pending.get(String(agent?.id))
    if (!state) { yield* next(); return }
    let failure
    try {
      state.signal.throwIfAborted()
      if (++state.requests > state.maxSteps) throw fail('probe_step_limit')
      // The assembled system/messages/tools are immutable; budget the actual request, never rewrite it.
      const ticket = state.reserve(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }))
      let outcome = 'provider_failure', usage
      const timer = setTimeout(state.expire, requestTimeoutMs)
      try {
        for await (const chunk of next()) {
          state.signal.throwIfAborted()
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'finish') outcome = chunk.reason?.kind === 'stop' || chunk.reason?.kind === 'tool-calls' ? 'ok' : chunk.reason?.kind ?? 'provider_failure'
          yield chunk
        }
      } finally {
        clearTimeout(timer)
        if (state.signal.aborted) outcome = state.signal.reason?.code ?? 'cancelled'
        ticket.settle(outcome, usage)
      }
    } catch (error) { failure = error; throw error }
    finally { if (failure) state.failure = failure }
  }))
  const spawn = async ({ parent, cwd, task, files, signal, provider, model, reasoningEffort, maxSteps, reserve }) => {
    const available = capability(parent)
    if (!available.ok) throw fail(available.reason)
    if (!parent || typeof reserve !== 'function') throw fail('invalid_probe_context')
    const timeout = new AbortController()
    signal = AbortSignal.any([signal, timeout.signal])
    signal.throwIfAborted()
    const childId = `evolve-probe-${randomUUID()}`, state = { files, signal, maxSteps, reserve, requests: 0, ended: false, expire: () => timeout.abort(fail('request_timeout')) }
    pending.set(childId, state)
    recorder.start(childId, { scope: childId, turn: 1, intent: task })
    const started = Date.now()
    let activation, cleanup, primary
    const abort = () => { if (activation && !cleanup) cleanup = activation.dispose(); cleanup?.catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      activation = await get('subagents').startActivation({ provider: backend, childId, label: 'DSH Soul harness probe', delivery: 'caller', signal,
        request: { parent, cwd, prompt: [{ type: 'text', text: task }],
          agentOptions: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
          maxDepth: get('subagents').resolveMaxDepth() } })
      if (signal.aborted) abort()
      const result = await activation.result
      signal.throwIfAborted()
      if (state.failure) throw state.failure
      if (result.stopReason !== 'completed') throw fail('probe_incomplete', bounded(result.diagnostic ?? result.stopReason, 500))
      if (!state.ended || !state.requests || !state.metrics) throw fail('missing_probe_observation')
      const m = state.metrics
      return { toolErrors: m.toolErrors, toolCalls: m.toolCalls, steps: m.steps,
        complete: result.stopReason === 'completed' && m.complete, deliverable: false,
        durationMs: Date.now() - started, transcript: bounded(textBlocks(result.output ?? []), 12000), stopReason: result.stopReason }
    } catch (error) { primary = error; throw error }
    finally {
      signal.removeEventListener('abort', abort)
      try { if (activation) await (cleanup ?? activation.dispose()) }
      catch (error) { if (primary) primary.cleanup = String(error); else throw fail('probe_cleanup_failed') }
      finally { pending.delete(childId); recorder.turns.delete(childId) }
    }
  }
  return { spawn, capability, owns: id => pending.has(String(id)), stop: () => { for (const dispose of disposers.reverse()) dispose?.() } }
}
