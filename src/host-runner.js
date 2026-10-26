import { randomUUID } from 'node:crypto'
import { bounded, fail, textBlocks } from './util.js'
import { Recorder } from './observe.js'

// DSH 0.2.1 public seam: local spawn activations, caller-owned result and disposal.
// Register the exact child identity BEFORE startup: its first request may precede publication.
export function createHostRunner(ctx, { backend = 'spawn', requestTimeoutMs = 60000, components } = {}) {
  const get = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  const pending = new Map(), recorder = new Recorder(), disposers = [], running = new Set()
  let stopped = false
  const stateFor = agent => {
    const agents = get('agents'), seen = new Set()
    while (agent && !seen.has(agent.id)) {
      seen.add(agent.id)
      const state = pending.get(String(agent.id))
      if (state) return state
      const parentId = agent.session?.header?.parentSession
      const parent = parentId ? agents?.get(parentId) : null
      if (!parent || !agents?.isOwnedBy?.(agent.id, parent)) return null
      agent = parent
    }
    return null
  }
  const capability = parent => {
    const service = get('subagents'), agents = get('agents'), provider = service?.getProvider?.(backend)
    if (typeof service?.startActivation !== 'function' || typeof agents?.currentInitiator !== 'function') return { ok: false, reason: 'host_runner_unavailable' }
    if (!provider?.prepareContinuable || provider.inheritsParentContext !== false || !provider.capabilities?.agentOptions) return { ok: false, reason: 'local_spawn_unavailable' }
    if (parent && agents.get(parent.id) !== parent) return { ok: false, reason: 'parent_unavailable' }
    return { ok: !stopped, backend, api: 'subagents.startActivation', supportedTargets: components?.supportedTargets ?? ['C1', 'C2', 'C3', 'C4'] }
  }
  disposers.push(ctx.systemPrompt.context({ name: 'dsh-soul:probe:subagents.md', order: 960, interpolate: false,
    text: ({ agent }) => { const state = stateFor(agent); return state && (state.delegation || state.childId !== String(agent.id)) ? state.files['subagents.md'] ?? '' : '' } }))
  for (const [path, order] of [['system.md', 900], ['guardrails.md', 910], ['tools.md', 920], ['memory.md', 950]]) {
    disposers.push(ctx.systemPrompt.context({ name: `dsh-soul:probe:${path}`, order, interpolate: false,
      text: ({ agent }) => stateFor(agent)?.files[path] ?? '' }))
  }
  disposers.push(ctx.on('session/event', (session, event) => {
    const state = pending.get(String(session.id)) ?? stateFor(get('agents')?.get(session.id)); if (!state) return
    if (state.childId !== String(session.id) && !recorder.get(String(session.id))) {
      if (!['turn/start','step/start'].includes(event.type)) return
      recorder.start(String(session.id), {scope:state.childId,turn:1,intent:'nested delegation'})
    }
    recorder.observe(String(session.id), event.type, event.data)
    if (event.type === 'turn/end') {
      const metrics = recorder.end(String(session.id))
      if (state.childId === String(session.id)) { state.metrics = metrics; state.ended = true }
      const owner = state.owner ?? state
      if (String(session.id) !== owner.childId && metrics) for (const key of ['steps','toolCalls','toolErrors']) owner.nested[key] += metrics[key]
    }
  }))
  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    const agent = get('agents')?.currentInitiator(), state = stateFor(agent)
    if (!state) { yield* next(); return }
    let failure
    try {
      state.signal.throwIfAborted()
      const owner = state.owner ?? state
      if (++owner.requests > owner.maxSteps) throw fail('probe_step_limit')
      state.localRequests++
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
        if (Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)) {
          const tokens = usage.inputTokens + usage.outputTokens
          state.tokens += tokens
          if (owner !== state) owner.tokens += tokens
        } else { state.unknownUsage = true; owner.unknownUsage = true }
      }
    } catch (error) { failure = error; throw error }
    finally { if (failure) state.failure = failure }
  }))
  const spawnInner = async ({ parent, cwd, task, files, signal, provider, model, reasoningEffort, maxSteps, reserve, delegation = false }) => {
    const available = capability(parent)
    if (!available.ok) throw fail(available.reason)
    if (!parent || typeof reserve !== 'function') throw fail('invalid_probe_context')
    const timeout = new AbortController()
    signal = AbortSignal.any([signal, timeout.signal])
    signal.throwIfAborted()
    const inherited = stateFor(parent)
    const childId = `evolve-probe-${randomUUID()}`, state = { childId, files, signal, maxSteps, reserve: inherited?.reserve ?? reserve,
      requests: 0, localRequests: 0, tokens: 0, unknownUsage: false, delegation, ended: false,
      nested: {steps:0,toolCalls:0,toolErrors:0},
      owner: inherited?.owner ?? inherited, controller: timeout, expire: () => timeout.abort(fail('request_timeout')) }
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
      if (!state.ended || !state.localRequests || !state.metrics) throw fail('missing_probe_observation')
      const m = state.metrics
      return { toolErrors: m.toolErrors + state.nested.toolErrors, toolCalls: m.toolCalls + state.nested.toolCalls, steps: m.steps + state.nested.steps,
        complete: result.stopReason === 'completed' && m.complete, deliverable: false,
        tokens: state.unknownUsage ? null : state.tokens,
        durationMs: Date.now() - started, transcript: bounded(textBlocks(result.output ?? []), 12000), stopReason: result.stopReason }
    } catch (error) { primary = error; throw error }
    finally {
      signal.removeEventListener('abort', abort)
      try { if (activation) await (cleanup ?? activation.dispose()) }
      catch (error) { if (primary) primary.cleanup = String(error); else throw fail('probe_cleanup_failed') }
      finally { pending.delete(childId); recorder.turns.delete(childId) }
    }
  }
  const spawn = input => {
    if (stopped) return Promise.reject(fail('runner_stopped'))
    const promise = spawnInner(input)
    running.add(promise)
    promise.finally(() => running.delete(promise)).catch(() => {})
    return promise
  }
  return { spawn, capability, owns: id => pending.has(String(id)),
    reserveFor: agent => stateFor(agent)?.reserve,
    stop: async () => { stopped = true; for (const state of pending.values()) state.controller.abort(fail('cancelled')); await Promise.allSettled([...running]); for (const dispose of disposers.reverse()) dispose?.() } }
}
