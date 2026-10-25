import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './src/store.js'
import { Learner, hostGenerate, skillText } from './src/learner.js'
import { bounded, clean, human, integer, projectScope, textBlocks } from './src/util.js'
import { Evolution, evolutionSettings } from './src/evolution.js'
import { evolutionGenerate } from './src/evolution-model.js'

export const name = 'dsh-soul'
export const inject = ['tools', 'systemPrompt', 'commands', 'llm']

export function settings(input = {}) {
  const profileMatch = fileURLToPath(import.meta.url).replaceAll('\\', '/').match(/\/profiles\/([^/]+)\//)
  const profile = input.profile ?? profileMatch?.[1] ?? 'development'
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) throw new Error('profile 标识无效')
  for (const key of ['enabled', 'learning']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  const learningMode = input.learningMode ?? 'efficiency'
  if (!['efficiency', 'economy'].includes(learningMode)) throw new Error('learningMode 必须是 efficiency 或 economy')
  const efficient = learningMode === 'efficiency'
  const config = {
    enabled: input.enabled ?? true, learning: input.learning ?? false, profile, learningMode,
    // Keep the pre-rename namespace so existing memories and daily budgets survive.
    database: input.database ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-learning', profile, 'memory.sqlite'),
    provider: input.provider ?? '', model: input.model ?? '', reasoningEffort: input.reasoningEffort ?? '',
    dailyCalls: integer(input.dailyCalls, efficient ? 12 : 4, 0, 100),
    maxInputBytes: integer(input.maxInputBytes, efficient ? 18000 : 12000, 2000, 32000),
    maxOutputTokens: integer(input.maxOutputTokens, efficient ? 1600 : 600, 200, 4000),
    memoryBytes: integer(input.memoryBytes, efficient ? 3600 : 2400, 500, 6000),
    idleMs: integer(input.idleMs, efficient ? 10000 : 30000, 1000, 3600000),
    timeoutMs: integer(input.timeoutMs, 60000, 100, 120000),
    evolutionConfig: evolutionSettings(input),
  }
  if (config.learning && (!config.provider || !config.model)) throw new Error('后台学习需要明确设置 provider 和 model；可选择适合任务的强模型或经济模型')
  return config
}

const HELP = `DSH Soul 成长记忆（evolve run 会启动模型试验；其余管理命令不调用模型）
/learn remember 记住的内容                 当前项目事实，立即生效
/learn prefer 表达偏好                      当前项目偏好，立即生效
/learn prefer --profile 长期表达偏好         同一 profile 通用偏好
/learn search 关键词                        查有效记忆
/learn list [candidate|trial|active|deprecated]
/learn inbox                              候选和试用技能摘要、来源与下一步
/learn show ID                             来源和反馈
/learn accept ID                           接受记忆；技能仅进入试用
/learn revise ID 新内容                     修订为新版本，旧版失效
/learn forget ID                           删除及关联派生记录
/learn skill {"title":"...","preconditions":["..."],"steps":["..."],"checks":["..."],"counterexamples":[]}
/learn feedback ID pass|fail 使用结果说明    当前会话作为一次独立试用；2个会话通过才激活，失败即停用
/learn trials [技能ID]                     查看最近方法使用与观察指标
/learn trial 试用ID                        查看前后差异、证据和归因限制
/learn assess 试用ID helped|neutral|harmed|uncertain 审核理由
/learn review                              将近期证据排入学习队列（按配置后台处理）
/learn status                              查看预算、待处理及调用 usage
/learn evolve register 验证套件.json        注册当前项目固定任务及验收条件
/learn evolve run 套件ID                    异步启动提出→试验→组合→验证→递归→采用
/learn evolve list                         当前项目已授权验证套件
/learn evolve status [运行ID]               阶段、额度与结果
/learn evolve show 运行ID                   执行证据、策略与实际 usage
/learn evolve cancel [运行ID]               停止当前进化任务
/learn evolve rollback 套件ID               回退自动采用的方法
/learn evolve unregister 套件ID             移除套件、进化技能及试验正文
候选不会自动变成你的偏好。后台学习需在 bundle 中配置 learning/provider/model。`

export function command(store, raw, session) {
  const scope = projectScope(session), sessionId = String(session.id)
  const parsed = raw.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const verb = parsed?.[1] || 'help', text = parsed?.[2] || ''
  const rest = text.split(/\s+/)
  if (verb === 'help') return HELP
  if (verb === 'status') return JSON.stringify(store.stats(scope), null, 2)
  if (verb === 'inbox') return JSON.stringify(store.inbox(scope), null, 2)
  if (verb === 'trials') return JSON.stringify(store.experience.list(scope, text), null, 2)
  if (verb === 'trial') {
    const row = store.experience.get(text, scope)
    if (!row) throw new Error('试用不存在或不属于当前项目')
    return JSON.stringify(row, null, 2)
  }
  if (verb === 'assess') {
    const [key, verdict] = rest
    return JSON.stringify(store.experience.assess(key, scope, verdict, text.replace(/^\S+\s+\S+\s*/, '')), null, 2)
  }
  if (verb === 'list') return JSON.stringify(store.search(scope, '', { status: text || 'active', limit: 20 }), null, 2)
  if (verb === 'search') return JSON.stringify(store.search(scope, text, { limit: 12 }), null, 2)
  if (verb === 'show') {
    const row = store.get(text, scope)
    if (!row) throw new Error('记忆不存在或不属于当前范围')
    return JSON.stringify({ ...row, evidence: row.sources.map(key => store.event(key)) }, null, 2)
  }
  if (verb === 'remember' || verb === 'prefer') {
    const global = text.startsWith('--profile ')
    const target = global ? 'profile' : scope
    return `已记录：${store.remember(target, verb === 'prefer' ? 'preference' : 'fact', global ? text.slice(10) : text, sessionId)}`
  }
  if (verb === 'skill') return `技能候选：${store.remember(scope, 'skill', skillText(text), sessionId)}`
  if (verb === 'accept') return `状态：${store.accept(text, scope)}`
  if (verb === 'forget') return `已删除 ${store.forget(text, scope)} 条记忆及关联来源；宿主原聊天记录不在插件删除范围内。`
  if (verb === 'revise') {
    const [key] = rest
    const old = store.get(key, scope)
    const body = text.slice(key.length).trimStart()
    return `新版本：${store.revise(key, scope, old?.kind === 'skill' ? skillText(body) : body, sessionId)}`
  }
  if (verb === 'feedback') {
    const [key, verdict] = rest
    const note = text.replace(/^\S+\s+\S+\s*/, '')
    return `状态：${store.feedback(key, scope, sessionId, verdict, note)}`
  }
  if (verb === 'review') {
    store.capture({ eventId: `review:${Date.now()}`, session: sessionId, scope, role: 'command', text: '用户请求整理近期可复用经验。', priority: 1 })
    return `已排队：${store.enqueue(sessionId, scope) ?? '无新增证据'}。后台学习关闭时不会调用模型。`
  }
  throw new Error('未知子命令，使用 /learn help')
}

const output = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: value.text }] }
const str = description => ({ type: 'string', description })
const tools = [
  { name: 'learning_search', description: '查当前范围的有效记忆和相关试用技能卡片。partial 必须用 learning_get 或 learning_trial 读全文及反例后使用；trial 未验证充分，只能作待检查方案。不存在时不编造。', properties: { query: str('关键词；中文可用') }, required: ['query'] },
  { name: 'learning_get', description: '按 ID 查看当前范围记忆及其来源，包含技能的条件、步骤、检查与反例。', properties: { id: str('记忆 ID') }, required: ['id'] },
  { name: 'learning_propose', description: '提出有来源的记忆或结构化技能候选，不激活、不覆盖偏好。技能只提炼实际证据，保留适用条件、检查及反例；不能把模型自评当成效果。用 /learn inbox 审核。', properties: { kind: { type: 'string', enum: ['preference', 'fact', 'episode', 'skill'] }, text: str('简短内容；skill 为含 title/preconditions/steps/checks/counterexamples 的 JSON 字符串'), sources: str('可选：learning_evidence 返回的当前会话来源 ID 的 JSON 数组；默认最近用户消息') }, required: ['kind', 'text'] },
  { name: 'learning_trial', description: '采用已接受的技能前登记方法使用，返回完整技能。只登记，不执行额外任务。goal 为具体成功标准，change 为本次方法变化；有同目标的历史基线才传 baseline。优先复用有效方法，质量优先于速度。', properties: { id: str('技能 ID'), goal: str('本任务目标与成功标准'), change: str('本次采用或改变的方法'), baseline: str('可选：已经完成且同目标的试用 ID') }, required: ['id', 'goal', 'change'] },
  { name: 'learning_evidence', description: '查看当前会话最近用户/工具观察及当前轮次指标，供候选或试用报告引用。工具未报错、运行结束不代表任务成功；不重复执行操作来制造证据。', properties: {}, required: [] },
  { name: 'learning_result', description: '记录当前会话的技能使用报告，模型判断保持未审核。用 learning_evidence 的本轮来源，区分 helped/neutral/harmed/uncertain；缺基线或多项变更不能声称因果。不能激活技能。', properties: { id: str('试用 ID'), report: str('JSON：{"verdict":"helped|neutral|harmed|uncertain","note":"观察和限制","sourceIds":["本轮来源ID"]}') }, required: ['id', 'report'] },
  { name: 'learning_evolve', description: '对用户已注册的本项目验证套件启动真正的方法进化：独立执行候选、组合、回归验证后择优采用。重复失败或缺少可靠方法时使用；简单任务直接做。不修改验收规则或执行宿主命令。启动后用 learning_evolution_status 查询，不重复启动。', properties: { suite: str('已注册套件 ID') }, required: ['suite'] },
  { name: 'learning_evolution_status', description: '查看本项目已授权的进化套件和最近执行状态；指定 id 时查看运行摘要。', properties: { id: str('可选：运行 ID') }, required: [] },
]

export function apply(ctx, input = {}) {
  const config = settings(input)
  if (!config.enabled) return
  const store = new Store(config.database)
  const pending = new Map(), lastHuman = new Map(), active = new Set(), failures = new Map(), disposers = []
  let lastActivity = Date.now(), lastMaintenance = 0, disposed = false, timer
  const llm = config.learning || config.evolutionConfig.enabled ? (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) : null
  if ((config.learning || config.evolutionConfig.enabled) && !llm?.stream) { store.close(); throw new Error('学习/进化缺少 DSH llm 服务') }
  const learner = new Learner(store, config.learning ? hostGenerate(llm, config) : null, config)
  const evolution = new Evolution(store, config.evolutionConfig.enabled ? evolutionGenerate(llm, config.evolutionConfig) : null, config.evolutionConfig)
  const safe = fn => (...args) => { try { return fn(...args) } catch { try { store.metric('contained_errors') } catch {} } }
  const listen = (event, handler) => disposers.push(ctx.on(event, handler))
  const describe = agent => ({ session: agent.session, scope: projectScope(agent.session) })
  const rememberUser = (session, message, eventId) => {
    if (!human(message) || session.header?.origin === 'subagent') return
    const text = textBlocks(message.content)
    if (!text.trim()) return
    pending.set(String(session.id), bounded(text, 2000))
    lastActivity = Date.now()
    const priority = /以后|记住|纠正|不对|别再|下次|remember|from now on|correction/i.test(text) ? 2 : 0
    const key = store.capture({ eventId, session: String(session.id), scope: projectScope(session), role: 'user', text, priority })
    if (key) { lastHuman.set(String(session.id), key); store.experience.trackSource(String(session.id), projectScope(session), key) }
  }
  try {
    // Observe accepted user input before assembly; never mutate the admission decision.
    listen('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const messages = decision?.messages ?? payload.messages
      if (decision?.kind !== 'reject') safe(() => {
        for (const message of messages) if (human(message)) pending.set(String(payload.agent.session.id), bounded(textBlocks(message.content), 2000))
      })()
      return decision
    })
    listen('agent/status', safe(({ agent, status }) => {
      if (status === 'running') active.add(String(agent.session.id)); else active.delete(String(agent.session.id))
      lastActivity = Date.now()
    }))
    listen('agent/disposed', safe(({ agent }) => {
      const key = String(agent.session.id)
      store.experience.interrupt(key)
      pending.delete(key); lastHuman.delete(key); active.delete(key); failures.delete(key)
    }))
    listen('session/event', safe((session, event) => {
      if (disposed || session.header?.origin === 'subagent') return
      const scope = projectScope(session), sid = String(session.id)
      if (event.type === 'turn/start') failures.set(sid, 0)
      store.experience.observe(sid, scope, event.seq, event.type, event.data)
      if (event.type === 'user/message') rememberUser(session, event.data, event.seq)
      if (event.type === 'assistant/message' && !event.data.interrupted) {
        const text = textBlocks(event.data.message?.content)
        if (text.trim()) store.capture({ eventId: event.seq, session: sid, scope, role: 'assistant', text })
      }
      if (event.type === 'tool/result') {
        const message = event.data.message
        // Only retain bounded successful observations during a registered method trial.
        // Soul's own tool results are not independent evidence of task success.
        const toolName = store.experience.toolName(sid, scope, message?.toolCallId)
        if (toolName && !toolName.startsWith('learning_') && message?.isError) failures.set(sid, (failures.get(sid) ?? 0) + 1)
        if (!toolName?.startsWith('learning_') && (message?.isError || (toolName && store.experience.wantsObservation(sid, scope)))) {
          const key = store.capture({ eventId: event.seq, session: sid, scope, role: 'tool',
            text: `工具观察（${message?.isError ? '错误' : '未报告工具错误，不等于任务成功'}）：${bounded(textBlocks(message?.content) || '无可读结果', 1600)}`, priority: message?.isError ? 1 : 0 })
          store.experience.trackSource(sid, scope, key)
        }
      }
      if (event.type === 'turn/end') {
        store.enqueue(sid, scope); lastActivity = Date.now()
        if ((failures.get(sid) ?? 0) >= 2 && config.evolutionConfig.enabled) evolution.automatic(scope, sid, pending.get(sid) ?? '')
        failures.delete(sid)
      }
    }))
    disposers.push(ctx.systemPrompt.context({ name: 'dsh-soul:memory', order: 950, text: ({ agent }) => {
      if (!agent || disposed || agent.session.header?.origin === 'subagent') return ''
      try { return store.recall(projectScope(agent.session), pending.get(String(agent.session.id)) ?? '', config.memoryBytes) }
      catch { return '' }
    } }))
    for (const definition of tools) disposers.push(ctx.tools.register({
      name: definition.name, description: definition.description, output,
      parameters: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false },
      async execute(args, exec) {
        exec?.signal?.throwIfAborted()
        if (!exec?.agent?.session) throw new Error('需要当前 DSH 会话')
        for (const key of definition.required) if (typeof args?.[key] !== 'string' || !args[key].trim()) throw new Error('缺少工具参数')
        if (Object.keys(args).some(key => !(key in definition.properties))) throw new Error('不支持的参数')
        for (const key of Object.keys(args)) if (typeof args[key] !== 'string') throw new Error('工具参数必须是文字')
        const { session, scope } = describe(exec.agent)
        let value
        if (definition.name === 'learning_evolve') value = evolution.start(scope, args.suite, String(session.id))
        else if (definition.name === 'learning_evolution_status') value = { suites: evolution.list(scope), runs: evolution.status(scope, args.id) }
        else if (definition.name === 'learning_search') value = store.discover(scope, clean(args.query, 2000))
        else if (definition.name === 'learning_get') {
          const row = store.get(args.id, scope)
          value = row ? { ...row, evidence: row.sources.slice(0, 4).map(key => {
            const e = store.event(key)
            return e ? { ...e, text: bounded(e.text, 1800) } : null
          }).filter(Boolean) } : { error: '记忆不存在或不属于当前范围' }
        }
        else if (definition.name === 'learning_trial') value = store.experience.start({ memory: args.id, scope, session: String(session.id), goal: args.goal, change: args.change, baseline: args.baseline })
        else if (definition.name === 'learning_evidence') value = store.experience.evidence(String(session.id), scope)
        else if (definition.name === 'learning_result') value = store.experience.report(args.id, scope, String(session.id), args.report)
        else {
          if (!['preference', 'fact', 'episode', 'skill'].includes(args.kind)) throw new Error('候选类型无效')
          const source = lastHuman.get(String(session.id))
          const sourceIds = args.sources ? JSON.parse(args.sources) : source ? [source] : []
          if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 12) throw new Error('需要 1–12 条当前会话来源')
          for (const key of sourceIds) {
            const e = store.event(key)
            if (!e || e.session !== String(session.id) || e.scope !== scope || !['user', 'tool'].includes(e.role)) throw new Error('来源必须是当前会话的用户表达或工具观察')
          }
          if (args.kind === 'preference' && !sourceIds.some(key => store.event(key).role === 'user')) throw new Error('偏好必须引用用户表达')
          const key = store.tx(() => store.add({ scope, kind: args.kind, text: args.kind === 'skill' ? skillText(args.text) : args.text, sourceIds }))
          value = { id: key, status: store.get(key, scope).status }
        }
        return { text: JSON.stringify(value) }
      },
    }))
    disposers.push(ctx.commands.register({ name: 'learn', description: '管理成长记忆、技能与进化任务（evolve run 会调用模型）', input: { hint: 'help / remember / prefer / search / status / evolve' }, recordInput: false,
      handler: async ({ agent, rawInput, signal }) => {
        try {
          signal?.throwIfAborted()
          if (/^evolve(?:\s|$)/.test(rawInput.trim())) return { kind: 'success', text: JSON.stringify(await evolution.command(rawInput.trim().slice(6), agent.session, projectScope(agent.session)), null, 2) }
          if (rawInput.trim() === 'status') return { kind: 'success', text: JSON.stringify({
            learning: config.learning, learningMode: config.learningMode, provider: config.provider, model: config.model,
            limits: { dailyCalls: config.dailyCalls, maxEvidenceBytes: config.maxInputBytes, maxOutputTokens: config.maxOutputTokens, memoryBytes: config.memoryBytes },
            ...store.stats(projectScope(agent.session)),
          }, null, 2) }
          return { kind: 'success', text: command(store, rawInput, agent.session) }
        }
        catch (e) { return { kind: 'error', text: bounded(e.message, 500) } }
      },
    }))
    timer = setInterval(() => {
      if (disposed || active.size || Date.now() - lastActivity < config.idleMs) return
      if (Date.now() - lastMaintenance > 3600000) { safe(() => store.maintain())(); lastMaintenance = Date.now() }
      if (config.learning && !evolution.running) learner.tick().catch(() => {})
    }, Math.min(5000, config.idleMs))
    timer.unref?.()
    const stop = async () => {
      if (disposed) return
      disposed = true; clearInterval(timer)
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
      await Promise.all([learner.stop(), evolution.stop()]); store.close()
    }
    // Cordis accepts a disposer (not a plain diagnostic object) as startup result.
    return Object.assign(stop, { store, learner, evolution, stop, config })
  } catch (e) {
    clearInterval(timer)
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    store.close(); throw e
  }
}
