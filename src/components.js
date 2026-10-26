import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { bounded, fail, hash, projectScope } from './util.js'

export function skillOf(path, text) {
  const m = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(path)
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(text)
  if (!m || !front) throw fail('invalid_skill', '技能需 skills/<name>/SKILL.md 和 name/description 元数据')
  const fields = Object.fromEntries(front[1].split(/\r?\n/).map(line => {
    const match = /^(name|description):\s*(.+)$/.exec(line)
    if (!match) throw fail('invalid_skill_metadata')
    return [match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]
  }))
  if (fields.name !== m[1] || !fields.description?.trim() || fields.description.length > 240) throw fail('invalid_skill_metadata')
  return { name: `soul-${m[1]}`, description: fields.description, content: front[2], path }
}

export function runComponent(code, input, { kind = 'script', signal, timeoutMs = kind === 'hook' ? 1000 : 5000 } = {}) {
  signal?.throwIfAborted()
  const payload = JSON.stringify({ code, input, kind })
  if (Buffer.byteLength(payload) > 100000) throw fail('component_input_limit')
  const worker = fileURLToPath(new URL('./component-worker.js', import.meta.url))
  return new Promise((resolveResult, reject) => {
    // Never inherit credentials or NODE_OPTIONS. Node permissions provide another
    // filesystem/process boundary; VM restrictions alone are not a security sandbox.
    const env = {}
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${worker}`, '--experimental-vm-modules', '--max-old-space-size=32', worker], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', error
    const kill = reason => { error ??= reason; child.kill() }
    const abort = () => kill(signal.reason ?? fail('cancelled'))
    const timer = setTimeout(() => kill(fail('component_timeout')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', data => { out += data; if (Buffer.byteLength(out) > 26000) kill(fail('component_output_limit')) })
    child.stderr.resume()
    child.on('error', e => { error ??= e })
    child.stdin.on('error', () => {})
    child.on('close', () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { reject(error); return }
      try {
        const result = JSON.parse(out)
        if (!result.ok) throw fail('component_failed', result.error)
        resolveResult(result.value)
      } catch (e) { reject(e) }
    })
    child.stdin.end(payload)
  })
}

export function createComponents(ctx, { current, enabled = () => true, audit = () => {} }) {
  const leases = new Map(), disposers = []
  const lifetime = new AbortController(), jobs = new Set()
  const executeComponent = (code, input, options) => {
    const promise = Promise.resolve().then(() => runComponent(code, input, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal,lifetime.signal]) : lifetime.signal }))
    jobs.add(promise); promise.finally(()=>jobs.delete(promise)).catch(()=>{})
    return promise
  }
  const get = key => typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  const keyOf = cwd => {
    // The host canonicalizes cwd; Windows TEMP can contain an 8.3 alias and
    // directory junctions can also make the same checkout have two spellings.
    let path = resolve(cwd)
    try { path = realpathSync.native(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const key = path.replaceAll('\\', '/')
    return process.platform === 'win32' ? key.toLowerCase() : key
  }
  let control, stopped = false, delegate
  const filesAt = cwd => {
    if (stopped || !cwd || !enabled()) return null
    return leases.get(keyOf(cwd)) ?? current(projectScope({ header: { cwd } }))?.files ?? null
  }
  const cwdFor = agent => agent?.session ? get('workingDirectory')?.get?.(agent.session) ?? agent.session.header?.cwd : null
  const filesFor = agent => filesAt(cwdFor(agent))
  const invalidate = () => control?.invalidate()
  const skills = get('skills')
  if (skills?.registerProvider) disposers.push(skills.registerProvider(c => {
    control = c
    return {
      name: 'dsh-soul',
      async list({ cwd, signal } = {}) {
        signal?.throwIfAborted()
        const files = filesAt(cwd) ?? {}
        return Object.entries(files).filter(([p]) => p.startsWith('skills/')).map(([path, text]) => {
          const s = skillOf(path, text)
          return { name: s.name, description: s.description, provider: 'dsh-soul', source: 'runtime', rank: 600,
            invocation: { modelInvocable: true, userInvocable: true }, locator: { path, digest: hash(text) } }
        })
      },
      async get(candidate, { cwd, signal } = {}) {
        signal?.throwIfAborted()
        const text = filesAt(cwd)?.[candidate.locator.path]
        if (!text || hash(text) !== candidate.locator.digest) return undefined
        return { ...candidate, content: skillOf(candidate.locator.path, text).content }
      },
    }
  }))

  const output = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_, value) => [{ type: 'text', text: value.text }] }
  const register = (name, description, properties, required, execute) => disposers.push(ctx.tools.register({ name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent || !filesFor(exec.agent)) throw fail('no_active_harness')
      return { text: JSON.stringify(await execute(args, exec)) }
    } }))
  register('evolve_catalog', '列出当前项目版本可用的技能与脚本；技能用宿主 Skill 工具按需加载。', {}, [], async (_, exec) => {
    const files = filesFor(exec.agent)
    return { skills: Object.entries(files).filter(([p]) => p.startsWith('skills/')).map(([p, t]) => { const s = skillOf(p, t); return { name: s.name, description: s.description } }),
      scripts: Object.keys(files).filter(p => /^scripts\/[a-zA-Z0-9_-]+\.mjs$/.test(p)), delegationPolicy: files['subagents.md'] ?? '' }
  })
  register('evolve_script', '运行当前版本的纯 JSON 转换脚本。无文件、网络、进程和宿主工具接口；返回结果，文件写入仍用宿主工具。',
    { name: { type: 'string' }, input: { type: 'string', description: 'JSON 字符串' } }, ['name', 'input'], async (args, exec) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(args.name)) throw fail('invalid_script_name')
      const code = filesFor(exec.agent)[`scripts/${args.name}.mjs`]
      if (!code) throw fail('script_not_found')
      return executeComponent(code, JSON.parse(args.input), { signal: exec.signal })
    })
  register('evolve_delegate', '先用 evolve_catalog 读取委派规则，再启动真实 DSH spawn 子任务。说明具体任务与验收标准；继承宿主深度与权限边界，会调用模型。',
    { task: { type: 'string' } }, ['task'], async (args, exec) => {
      if (!delegate || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 6000) throw fail('invalid_delegation')
      return delegate({ parent: exec.agent, cwd: cwdFor(exec.agent), task: args.task, files: filesFor(exec.agent), signal: exec.signal })
    })

  disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || 'value' in decision || exec.name?.startsWith('evolve_')) return decision
    const files = filesFor(exec.agent)
    if (!files) return decision
    const notes = []
    for (const [path, code] of Object.entries(files).filter(([p]) => p.startsWith('hooks/')).slice(0, 4)) {
      try {
        const response = await executeComponent(code, { event: 'tool-result', tool: exec.name, isError: result.isError,
          output: bounded(JSON.stringify(result.content), 4000) }, { kind: 'hook', signal: exec.signal })
        if (typeof response?.note === 'string' && response.note.trim()) notes.push({ type: 'text', text: `[Soul hook ${path}] ${bounded(response.note, 600)}` })
      } catch (error) { if (!stopped) audit(exec.agent, { path, outcome: 'fail_open', reason: error.code ?? 'component_failed' }) }
    }
    // Advisory output only. Never overwrite canonical values, hide errors, or
    // reverse a denial/block from another host policy.
    return notes.length ? { ...decision, content: [...(decision.content ?? result.content), ...notes] } : decision
  }))
  return {
    filesFor, filesAt, cwdFor, invalidate,
    supportedTargets: skills?.registerProvider ? ['C1','C2','C3','C4','C5','C6','C7','C8'] : ['C1','C2','C3','C4','C5','C7','C8'],
    setDelegate(fn) { delegate = fn },
    lease(cwd, files) {
      const key = keyOf(cwd)
      if (leases.has(key)) throw fail('component_lease_busy')
      leases.set(key, files); invalidate()
      return () => { if (leases.get(key) === files) { leases.delete(key); invalidate() } }
    },
    async stop() { stopped = true; lifetime.abort(fail('component_stopped')); for (const dispose of disposers.reverse()) dispose?.(); leases.clear(); await Promise.allSettled([...jobs]) },
  }
}
