import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './src/store.js'
import { Learner, hostGenerate, skillText } from './src/learner.js'
import { bounded, clean, human, integer, projectScope, textBlocks } from './src/util.js'

export const name = 'dsh-learning'
export const inject = ['tools', 'systemPrompt', 'commands', 'llm']

export function settings(input = {}) {
  const profileMatch = fileURLToPath(import.meta.url).replaceAll('\\', '/').match(/\/profiles\/([^/]+)\//)
  const profile = input.profile ?? profileMatch?.[1] ?? 'development'
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) throw new Error('profile 标识无效')
  for (const key of ['enabled', 'learning']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  const config = {
    enabled: input.enabled ?? true, learning: input.learning ?? false, profile,
    database: input.database ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-learning', profile, 'memory.sqlite'),
    provider: input.provider ?? '', model: input.model ?? '', reasoningEffort: input.reasoningEffort ?? '',
    dailyCalls: integer(input.dailyCalls, 4, 0, 100),
    maxInputBytes: integer(input.maxInputBytes, 12000, 2000, 32000),
    maxOutputTokens: integer(input.maxOutputTokens, 600, 200, 2000),
    memoryBytes: integer(input.memoryBytes, 2400, 500, 6000),
    idleMs: integer(input.idleMs, 30000, 1000, 3600000),
    timeoutMs: integer(input.timeoutMs, 60000, 100, 120000),
  }
  if (config.learning && (!config.provider || !config.model)) throw new Error('后台学习需要明确设置 provider 和 model；不会偷偷沿用昂贵主模型')
  return config
}

const HELP = `DSH 成长记忆（这些命令不调用模型）
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
/learn review                              将近期证据排入学习队列（按配置后台处理）
/learn status                              查看预算、待处理及调用 usage
候选不会自动变成你的偏好。后台学习需在 bundle 中配置 learning/provider/model。`

export function command(store, raw, session) {
  const scope = projectScope(session), sessionId = String(session.id)
  const parsed = raw.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const verb = parsed?.[1] || 'help', text = parsed?.[2] || ''
  const rest = text.split(/\s+/)
  if (verb === 'help') return HELP
  if (verb === 'status') return JSON.stringify(store.stats(scope), null, 2)
  if (verb === 'inbox') return JSON.stringify(store.inbox(scope), null, 2)
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
  { name: 'learning_search', description: '查当前范围的有效记忆和相关试用技能卡片。partial 必须 learning_get 读全文及反例后使用；trial 未验证充分，只能作待检查方案。不存在时不编造。', properties: { query: str('关键词；中文可用') }, required: ['query'] },
  { name: 'learning_get', description: '按 ID 查看当前范围记忆及其来源，包含技能的条件、步骤、检查与反例。', properties: { id: str('记忆 ID') }, required: ['id'] },
  { name: 'learning_propose', description: '提出有当前用户消息作为来源的记忆候选，不能自动激活、覆盖偏好或改变权限。告诉用户可用 /learn list candidate 检查。', properties: { kind: { type: 'string', enum: ['preference', 'fact', 'episode'] }, text: str('有范围、可纠正的简短内容') }, required: ['kind', 'text'] },
]

export function apply(ctx, input = {}) {
  const config = settings(input)
  if (!config.enabled) return
  const store = new Store(config.database)
  const pending = new Map(), lastHuman = new Map(), active = new Set(), disposers = []
  let lastActivity = Date.now(), lastMaintenance = 0, disposed = false, timer
  const llm = config.learning ? (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) : null
  if (config.learning && !llm?.stream) { store.close(); throw new Error('后台学习缺少 DSH llm 服务') }
  const learner = new Learner(store, config.learning ? hostGenerate(llm, config) : null, config)
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
    if (key) lastHuman.set(String(session.id), key)
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
      pending.delete(key); lastHuman.delete(key); active.delete(key)
    }))
    listen('session/event', safe((session, event) => {
      if (disposed || session.header?.origin === 'subagent') return
      const scope = projectScope(session), sid = String(session.id)
      if (event.type === 'user/message') rememberUser(session, event.data, event.seq)
      if (event.type === 'assistant/message' && !event.data.interrupted) {
        const text = textBlocks(event.data.message?.content)
        if (text.trim()) store.capture({ eventId: event.seq, session: sid, scope, role: 'assistant', text })
      }
      if (event.type === 'tool/result') {
        const message = event.data.message
        // Store a bounded error observation, not entire tool outputs or commands/secrets.
        if (message?.isError) store.capture({ eventId: event.seq, session: sid, scope, role: 'tool', text: `工具失败：${textBlocks(message.content) || '未提供可读错误'}`, priority: 1 })
      }
      if (event.type === 'turn/end') { store.enqueue(sid, scope); lastActivity = Date.now() }
    }))
    disposers.push(ctx.systemPrompt.context({ name: 'dsh-learning:memory', order: 950, text: ({ agent }) => {
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
        const { session, scope } = describe(exec.agent)
        let value
        if (definition.name === 'learning_search') value = store.discover(scope, clean(args.query, 2000))
        else if (definition.name === 'learning_get') {
          const row = store.get(args.id, scope)
          value = row ? { ...row, evidence: row.sources.slice(0, 4).map(key => {
            const e = store.event(key)
            return e ? { ...e, text: bounded(e.text, 1800) } : null
          }).filter(Boolean) } : { error: '记忆不存在或不属于当前范围' }
        }
        else {
          if (!['preference', 'fact', 'episode'].includes(args.kind)) throw new Error('候选类型无效')
          const source = lastHuman.get(String(session.id))
          if (!source) throw new Error('没有当前用户消息作为依据')
          value = { id: store.tx(() => store.add({ scope, kind: args.kind, text: args.text, sourceIds: [source] })), status: 'candidate' }
        }
        return { text: JSON.stringify(value) }
      },
    }))
    disposers.push(ctx.commands.register({ name: 'learn', description: '查看与管理成长记忆、技能和学习预算（不调用模型）', input: { hint: 'help / remember / prefer / search / status' }, recordInput: false,
      handler: ({ agent, rawInput, signal }) => {
        try {
          signal?.throwIfAborted()
          if (rawInput.trim() === 'status') return { kind: 'success', text: JSON.stringify({
            learning: config.learning, provider: config.provider, model: config.model,
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
      if (config.learning) learner.tick().catch(() => {})
    }, Math.min(5000, config.idleMs))
    timer.unref?.()
    const stop = async () => {
      if (disposed) return
      disposed = true; clearInterval(timer)
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
      await learner.stop(); store.close()
    }
    // Cordis accepts a disposer (not a plain diagnostic object) as startup result.
    return Object.assign(stop, { store, learner, stop, config })
  } catch (e) {
    clearInterval(timer)
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    store.close(); throw e
  }
}
