import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fail, virtualPath } from './evolution-suite.js'

function cli(args, { signal, input = '', timeoutMs = 15000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = '', bytes = 0, failure
    const stop = reason => { failure ??= reason; child.kill('SIGKILL') }
    const timer = setTimeout(() => stop(fail('sandbox_timeout')), timeoutMs)
    const abort = () => stop(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.on('error', () => { cleanup(); reject(fail('sandbox_unavailable', '需要本地 Docker Linux 引擎与预先准备的 Node 镜像')) })
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64000) stop(fail('sandbox_output_limit')); else stdout += chunk.toString() })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 64000) stop(fail('sandbox_output_limit')) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('close', code => { cleanup(); if (failure) reject(failure); else resolve({ code, stdout }) })
  })
}

const program = timeoutMs => `import {Worker} from 'node:worker_threads';let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);const worker=new Worker(\`const {parentPort,workerData}=require('node:worker_threads');import('/workspace/solution.mjs').then(m=>m.default(workerData)).then(value=>parentPort.postMessage(value)).catch(()=>process.exit(1));\`,{eval:true,workerData:input,resourceLimits:{maxOldGenerationSizeMb:32,stackSizeMb:4}});const timer=setTimeout(()=>process.exit(124),${timeoutMs});worker.once('message',value=>{process.stdout.write(JSON.stringify(value));clearTimeout(timer);process.exit(0)});worker.once('error',()=>process.exit(1));worker.once('exit',code=>{if(code)process.exit(code)});`

// No user/model-supplied command line, image, host mount or Docker option is accepted from a suite.
// The configured local image is resolved to an immutable image ID before any model requests.
export async function prepareDocker(image, signal) {
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(image)) throw fail('sandbox_unavailable', 'JavaScript 套件需要 evolutionDockerImage 指定已安装镜像')
  const context = await cli(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { signal })
  let endpoint
  try { endpoint = process.env.DOCKER_CONTEXT ? JSON.parse(context.stdout) : process.env.DOCKER_HOST || JSON.parse(context.stdout) } catch { throw fail('sandbox_unavailable') }
  if (context.code || typeof endpoint !== 'string' || !/^(unix:\/\/\/|npipe:\/\/)/.test(endpoint)) throw fail('sandbox_unavailable', '代码试验仅支持本地 Docker endpoint')
  const env = { ...process.env }; delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST
  const args = ['--host', endpoint]
  const found = await cli([...args, 'image', 'inspect', '--format', '{{.Id}} {{.Os}}', image], { signal, env })
  const matched = found.stdout.trim().match(/^(sha256:[a-f0-9]{64}) linux$/)
  if (found.code || !matched) throw fail('sandbox_unavailable', '请先准备可运行 Node 的本地 Linux 镜像；插件不自动下载')
  return { args, image: matched[1], env }
}

export async function executeJavaScript(prepared, { files, input, signal, timeoutMs = 10000 }) {
  if (!files.has('solution.mjs')) return { ok: false, output: '', error: 'missing_solution' }
  const folder = await mkdtemp(join(tmpdir(), 'dsh-soul-probe-')), container = `dsh-soul-${randomUUID()}`
  let created = false, creationAttempted = false
  try {
    await chmod(folder, 0o755)
    if (folder.includes(',')) throw fail('sandbox_unavailable', 'Docker 临时目录不能包含逗号')
    for (const [path, content] of files) {
      virtualPath(path); const target = join(folder, path)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await writeFile(target, content, { mode: 0o644 })
    }
    signal.throwIfAborted(); creationAttempted = true
    const result = await cli([...prepared.args, 'create', '--name', container, '--label', 'dsh-soul=probe',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '128m', '--memory-swap', '128m', '--cpus', '1', '--user', '65534:65534',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', '--mount', `type=bind,source=${folder},target=/workspace,readonly`,
      '--workdir', '/workspace', '--interactive', '--entrypoint', 'node', prepared.image, '--input-type=module', '-e', program(timeoutMs),
    ], { signal, env: prepared.env })
    if (result.code) throw fail('sandbox_unavailable')
    created = true
    const execution = await cli([...prepared.args, 'start', '--attach', '--interactive', container],
      { signal, env: prepared.env, input: JSON.stringify(input), timeoutMs })
    return { ok: execution.code === 0, output: execution.stdout, error: execution.code ? 'program_error' : null }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (created && ['sandbox_timeout', 'sandbox_output_limit'].includes(error.code)) return { ok: false, output: '', error: error.code }
    throw error
  } finally {
    // Remove only our exact random container, and wait for cleanup before releasing this probe.
    let cleanupError
    if (creationAttempted) {
      try {
        const removed = await cli([...prepared.args, 'rm', '--force', '--volumes', container], { env: prepared.env, timeoutMs: 10000 })
        if (removed.code) {
          const existing = await cli([...prepared.args, 'ps', '--all', '--quiet', '--filter', `name=^/${container}$`], { env: prepared.env, timeoutMs: 10000 })
          if (existing.code || existing.stdout.trim()) cleanupError = fail('sandbox_cleanup', `无法确认试验容器已清理：${container}`)
        }
      } catch { cleanupError = fail('sandbox_cleanup', `无法确认试验容器已清理：${container}`) }
    }
    await rm(folder, { recursive: true, force: true })
    if (cleanupError) throw cleanupError
  }
}
