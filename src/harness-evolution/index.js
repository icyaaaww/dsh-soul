import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './src/store.js'
import { Evolve } from './src/evolve.js'
import { budgetSettings } from './src/budget.js'
import { Recorder, divergenceOf, isCorrection, trajectoryText, repeatCount, EMPTY_METRICS } from './src/observe.js'
import { diagnose } from './src/diagnose.js'
import { readDefaults } from './src/harness.js'
import { turnCounter } from './src/gate.js'
import { hostProbe } from './src/host-probe.js'
import { createHostRunner } from './src/host-runner.js'
import { projectScope, bounded, boolean, integer, human, textBlocks, fail } from './src/util.js'
import { sizeReport, COMPONENTS } from './src/tree.js'

export const name = 'dsh-soul-harness'
export const inject = ['tools', 'systemPrompt', 'commands', 'llm']

export function settings(input = {}) {
  const profileMatch = fileURLToPath(import.meta.url).replaceAll('\\', '/').match(/\/profiles\/([^/]+)\/node_modules\//)
  const profile = input.profile ?? profileMatch?.[1] ?? (input.database ? 'explicit-database' : null)
  if (!profile) throw new Error('无法确定 profile；请显式配置 profile 或独立 database 路径，拒绝回落到共享库')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) throw new Error('profile 标识无效')

  const enabled = boolean(input.enabled, false, 'enabled')
  const config = {
    enabled,
    profile,
    learning: boolean(input.learning, false, 'learning'),
    database: input.database ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-soul-harness', profile, 'evolve.sqlite'),
    // Evolution never inherits the learning route: a silent fallback is how an intended
    // "strong editor model" turns into "whatever the background job uses".
    provider: input.provider ?? '',
    model: input.model ?? '',
    reasoningEffort: input.reasoningEffort ?? '',
    injectHarness: boolean(input.injectHarness, true, 'injectHarness'),
    harnessFolder: input.harnessFolder ?? '.dsh-soul/harness',
    checks: Array.isArray(input.checks) ? input.checks : [],
    budget: budgetSettings(input),
  }
  if (config.learning) throw new Error('harnessEvolution 不提供后台记忆提炼；请在 Soul 顶层配置 learning')
  if (enabled && (!config.provider || !config.model)) throw new Error('开启演化需要显式配置 provider 与 model')
  if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.some(c => !c || typeof c.name !== 'string' || !Array.isArray(c.argv) || !c.argv.length || c.argv.some(a => typeof a !== 'string') || !c.argv[0]))) throw new Error('checks 必须包含 name 和非空字符串数组 argv')
  return config
}

const HELP = `DSH Soul — 真实宿主 harness 演化（单变量编辑 / 真实任务试用 / 在线基线）
/evolve status             当前版本、每轮固定税、额度、影子窗口
/evolve diagnose [n]       查看最近 n 轮观察的诊断结果，不花费模型调用
/evolve run                手动对最近一次分歧发起一次精炼
/evolve diff [A] [B]       两版组件差异，默认当前 stable 与最近影子版本
/evolve log [n]            审计账本
/evolve explain <rev>      某版本凭什么被采纳，含证据与闸门
/evolve rollback [rev]     回滚，默认回到父版本
/evolve watch              待决影子窗口
/evolve tree               8 个组件的大小与激活方式
/evolve lint               校验当前树（锚定区、上限、白名单）
/evolve export [目录]      把当前 harness 导出到项目内供人工审阅

演化默认关闭。开启需在 bundle 中显式配置 enabled: true 与 provider/model。`

const output = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}
const str = description => ({ type: 'string', description })
const tools = [
  {
    name: 'evolve_status',
    description: '查看当前项目的 harness 版本、每轮固定税、额度、影子窗口与最近 episode。不调用模型、不花钱。',
    properties: {}, required: [],
  },
  {
    name: 'evolve_diagnose',
    description: '对最近观察到的一次分歧做归因，返回目标组件与依据。不调用模型、不花钱。用于判断值不值得精炼。',
    properties: { episodeTurn: str('可选：指定观察序号；默认最近一次') }, required: [],
  },
  {
    name: 'evolve_request',
    description: '请求对最近一次已归因的分歧发起一次精炼（会花费模型调用探测）。只有在同类任务重复出现时才值得。返回是否有资格启动，不直接执行。',
    properties: { confirm: str('必须传入 "confirm" 表示你知道这会消耗额度') }, required: ['confirm'],
  },
  {
    name: 'evolve_tree',
    description: '列出 8 个 harness 组件的字节数、上限与激活方式，用于判断固定税是否膨胀。',
    properties: {}, required: [],
  },
]

const describe = agent => ({ session: agent.session, scope: projectScope(agent.session) })

export function apply(ctx, input = {}) {
  if (input.enabled === false) return
  const config = settings(input)
  if (!config.enabled) return

  const store = new Store(config.database)
  const recorder = new Recorder()
  const disposers = []
  const recent = new Map()      // session -> last finished observation
  const lastTurn = new Map()    // session -> { intent } to detect corrections
  let disposed = false

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
  if (!llm?.stream) { store.close(); throw new Error('演化需要宿主的 llm 服务') }

  const generate = async ({ system, data, phase, signal, onUsage }) => {
    const text = JSON.stringify(data)
    let body = '', finish
    for await (const chunk of llm.stream({
      provider: config.provider, model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      tools: [], maxTokens: 2400, signal,
    })) {
      signal?.throwIfAborted()
      if (chunk.type === 'text-delta') body += chunk.text
      if (chunk.type === 'usage') onUsage?.(chunk.usage)
      if (chunk.type === 'finish') finish = chunk.reason?.kind
      if (Buffer.byteLength(body) > 40000) throw fail('output_limit')
    }
    if (finish !== 'stop') throw fail(finish === 'max-tokens' ? 'truncated' : 'provider_failure')
    const cleaned = body.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    try { return JSON.parse(cleaned) } catch { throw fail('invalid_json') }
  }

  // Capability and clean-worktree checks run before any paid editor call.
  const runner = createHostRunner(ctx, { requestTimeoutMs: config.budget.requestTimeoutMs })
  const execute = hostProbe({
        spawn: runner.spawn, capability: runner.capability,
        provider: config.provider, model: config.model,
        reasoningEffort: config.reasoningEffort, steps: config.budget.probeSteps,
      })

  const evolve = new Evolve({ store, config, generate, execute, logger: () => {} })
  const safe = fn => (...args) => { try { return fn(...args) } catch { /* observation must never break a turn */ } }
  const listen = (event, handler) => disposers.push(ctx.on(event, handler))

  try {
    // ---- observation ------------------------------------------------------
    listen('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'reject' && payload.agent.session.header?.origin !== 'subagent') safe(() => {
        const sid = String(payload.agent.session.id)
        const previous = lastTurn.get(sid)
        const messages = decision?.messages ?? payload.messages ?? []
        for (const message of messages) {
          if (!human(message)) continue
          const text = textBlocks(message.content)
          if (!text.trim()) continue
          const correction = !!previous?.intent && isCorrection(text)
          const intent = correction ? previous.intent : text
          lastTurn.set(sid, { intent: bounded(intent, 2000) })
          if (!recorder.get(sid)) {
            recorder.start(sid, { scope: projectScope(payload.agent.session), turn: Date.now(), intent })
          }
          if (correction) {
            recorder.markCorrection(sid)
            const state = recorder.get(sid)
            state.text = bounded(`${intent}\n用户纠正：${text}`, 2000)
            // The correction refers to the preceding task, even when its wording differs.
            evolve.observe({ scope: state.scope, taskKey: state.taskKey, corrections: 1, toolErrors: 0, complete: true })
          }
        }
      })()
      return decision
    })

    listen('session/event', safe((session, event) => {
      if (disposed || session.header?.origin === 'subagent') return
      const sid = String(session.id)
      if (event.type === 'turn/end') {
        recorder.observe(sid, event.type, event.data)
        const state = recorder.end(sid)
        if (state) {
          turnCounter(store, state.scope).bump()
          const divergence = divergenceOf(state)
          recent.set(sid, { state, divergence })
          if (divergence) {
            store.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)')
              .run(`last:${state.scope}`, JSON.stringify({ taskKey: state.taskKey, text: bounded(state.text, 600), at: Date.now() }))
          }
          const key = `observations:${state.scope}`
          const rows = JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? '[]')
          if (divergence) rows.push({ task_key: state.taskKey, created: Date.now(), state: 'observed' })
          store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(rows.slice(-200)))
          evolve.observe({ scope: state.scope, taskKey: state.taskKey, corrections: state.corrections,
            toolErrors: state.toolErrors, complete: state.complete })
        }
        return
      }
      recorder.observe(sid, event.type, event.data)
    }))

    listen('agent/disposed', safe(({ agent }) => {
      const sid = String(agent.session.id)
      recorder.turns.delete(sid); lastTurn.delete(sid); recent.delete(sid)
    }))

    // ---- harness injection ------------------------------------------------
    // Only the four every-call components are injected, and each is its own context so a
    // stable component keeps its cache prefix while the volatile one changes.
    if (config.injectHarness) {
      for (const [key, spec, order] of [['C1', COMPONENTS.C1, 900], ['C2', COMPONENTS.C2, 910], ['C4', COMPONENTS.C4, 920], ['C3', COMPONENTS.C3, 950]]) {
        disposers.push(ctx.systemPrompt.context({
          name: `dsh-soul-harness:${key}`, order, interpolate: false,
          text: ({ agent }) => {
            if (!agent || disposed || agent.session.header?.origin === 'subagent') return ''
            const cwd = agent.session.header?.cwd
            if (!cwd) return ''
            try {
              const current = evolve.current(projectScope(agent.session))
              return current?.files?.[spec.path] ?? ''
            } catch { return '' }
          },
        }))
      }
    }

    // ---- tools ------------------------------------------------------------
    for (const definition of tools) {
      disposers.push(ctx.tools.register({
        name: definition.name, description: definition.description, output,
        parameters: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted()
          if (!exec?.agent?.session) throw new Error('需要当前 DSH 会话')
          for (const key of Object.keys(args ?? {})) if (!(key in definition.properties)) throw new Error('不支持的参数')
          for (const key of definition.required) if (typeof args?.[key] !== 'string') throw new Error(`缺少参数 ${key}`)
          const { session, scope } = describe(exec.agent)
          const current = evolve.current(scope)
          let value
          if (definition.name === 'evolve_status') value = { ...evolve.status(scope), hostProbe: runner.capability(session && exec.agent) }
          else if (definition.name === 'evolve_tree') value = current ? sizeReport(current.files) : sizeReport(readDefaults())
          else if (definition.name === 'evolve_diagnose') {
            const observation = recent.get(String(session.id))
            value = observation?.divergence
              ? { ...diagnose(observation.divergence), taskKey: observation.state.taskKey,
                  repeats: repeatCount(JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(`observations:${scope}`)?.value ?? '[]'), observation.state.taskKey, config.budget.repeatWindowMs),
                  note: '归因是规则表结果，零模型调用；是否值得精炼看重复次数是否达到阈值' }
              : { error: '当前会话最近一轮没有可归因的分歧' }
          } else {
            const observation = recent.get(String(session.id))
            if (!observation?.divergence) value = { started: false, reason: 'no_divergence' }
            else {
              const repeats = repeatCount(JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(`observations:${scope}`)?.value ?? '[]'), observation.state.taskKey, config.budget.repeatWindowMs)
              value = repeats < config.budget.repeatThreshold
                ? { started: false, reason: 'insufficient_repetition', repeats, need: config.budget.repeatThreshold,
                    note: '一次性任务不进化；同类任务重复出现才值得花额度' }
                : { started: false, reason: 'requires_host_command',
                    next: '/evolve run', target: diagnose(observation.divergence).target,
                    note: '工具不直接消耗额度；只有用户命令能启动付费探测' }
            }
          }
          return { text: JSON.stringify(value) }
        },
      }))
    }

    // ---- command ----------------------------------------------------------
    disposers.push(ctx.commands.register({
      name: 'evolve', description: '查看与回滚 harness 自演化状态（run 会消耗模型额度）',
      input: { hint: 'status / tree / diagnose / diff / log / rollback' }, recordInput: false,
      handler: async ({ agent, rawInput, signal }) => {
        try {
          signal?.throwIfAborted()
          const text = String(rawInput ?? '').trim()
          const [verb = 'status', ...args] = text.split(/\s+/)
          const { scope } = describe(agent)
          const cwd = agent.session.header?.cwd
          if (cwd) {
            evolve.ensure(scope, readDefaults())
          }
          if (verb === 'help') return { kind: 'success', text: HELP }
          if (verb === 'status') return { kind: 'success', text: JSON.stringify({ ...evolve.status(scope), hostProbe: runner.capability(agent) }, null, 2) }
          if (verb === 'tree') {
            const current = evolve.current(scope)
            const report = sizeReport(current?.files ?? readDefaults())
            return { kind: 'success', text: JSON.stringify(report, null, 2) }
          }
          if (verb === 'watch') return { kind: 'success', text: JSON.stringify(store.openWatches(scope), null, 2) }
          if (verb === 'log') {
            const n = Number(args[0]) || 20
            return { kind: 'success', text: JSON.stringify(store.ledger(scope, Math.min(200, n)), null, 2) }
          }
          if (verb === 'diagnose') {
            const observation = recent.get(String(agent.session.id))
            if (!observation?.divergence) return { kind: 'success', text: '当前会话最近一轮没有可归因的分歧。' }
            const repeats = repeatCount(JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(`observations:${scope}`)?.value ?? '[]'), observation.state.taskKey, config.budget.repeatWindowMs)
            return { kind: 'success', text: JSON.stringify({ ...diagnose(observation.divergence), repeats,
              threshold: config.budget.repeatThreshold, trajectory: trajectoryText(observation.state) }, null, 2) }
          }
          if (verb === 'run') {
            if (!config.injectHarness) return { kind: 'error', text: 'injectHarness 已关闭，无法把候选应用到真实任务。' }
            const observation = recent.get(String(agent.session.id))
            if (!observation?.divergence) return { kind: 'error', text: '没有可归因的分歧，不启动。' }
            const repeats = repeatCount(JSON.parse(store.db.prepare('SELECT value FROM meta WHERE key=?').get(`observations:${scope}`)?.value ?? '[]'), observation.state.taskKey, config.budget.repeatWindowMs)
            if (repeats < config.budget.repeatThreshold) {
              return { kind: 'error', text: `同类任务仅重复 ${repeats} 次（阈值 ${config.budget.repeatThreshold}），一次性任务不进化。` }
            }
            const result = await evolve.start({
              scope, taskKey: observation.state.taskKey, trigger: 'user_command',
              divergence: observation.divergence, metrics: observation.state,
              trajectory: trajectoryText(observation.state), task: observation.state.text,
              cwd, checks: config.checks, parent: agent,
            })
            return { kind: result.started ? 'success' : 'error', text: JSON.stringify(result, null, 2) }
          }
          if (verb === 'diff') {
            const [a, b] = args
            const to = b ? store.rev(b, scope) : store.latest(scope, ['shadow', 'stable'])
            const from = a ? store.rev(a, scope) : (to?.parent ? store.rev(to.parent, scope) : null)
            if (!to || !from) return { kind: 'error', text: '没有可比较的两个版本。' }
            const { diffTrees } = await import('./src/tree.js')
            return { kind: 'success', text: JSON.stringify(diffTrees(store.materialize(from.id), store.materialize(to.id)), null, 2) }
          }
          if (verb === 'explain') {
            const rev = args[0] ?? store.latest(scope, ['shadow', 'stable'])?.id
            if (!rev) return { kind: 'error', text: '没有版本。' }
            const rows = store.ledger(scope, 500).filter(r => r.rev === rev)
            return { kind: 'success', text: JSON.stringify({ rev, entries: rows }, null, 2) }
          }
          if (verb === 'rollback') {
            const result = evolve.rollback(scope, args[0] ?? null)
            return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result, null, 2) }
          }
          if (verb === 'lint') {
            const current = evolve.current(scope)
            const { checkStructure } = await import('./src/gate.js')
            const files = current?.files ?? readDefaults()
            const result = checkStructure({ target: 'C1', base: files, next: files })
            return { kind: 'success', text: JSON.stringify({ ok: result.ok, violations: result.violations, tax: result.tax }, null, 2) }
          }
          if (verb === 'export') {
            const current = evolve.current(scope)
            const target = args[0] ?? '.dsh-soul/export'
            if (!cwd) return { kind: 'error', text: '需要项目工作目录。' }
            const { installTree } = await import('./src/probe.js')
            const base = await installTree(cwd, current?.files ?? readDefaults(), { folder: target })
            return { kind: 'success', text: `已导出到 ${base}` }
          }
          return { kind: 'error', text: '未知子命令，使用 /evolve help' }
        } catch (error) {
          return { kind: 'error', text: bounded(error?.message ?? '执行失败', 500) }
        }
      },
    }))

    const stop = async () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
      await evolve.stop()
      runner.stop()
      store.close()
    }
    return Object.assign(stop, { store, evolve, stop, config, recorder, recent })
  } catch (error) {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    runner.stop()
    store.close()
    throw error
  }
}
