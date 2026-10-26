// Separate, killable process. No host objects, imports, filesystem or tool APIs are
// exposed to component code. This is not an OS sandbox/security guarantee.
import vm from 'node:vm'
let input = '', timer
for await (const chunk of process.stdin) {
  input += chunk
  if (Buffer.byteLength(input) > 100000) process.exit(2)
}
try {
  const payload = JSON.parse(input)
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  const module = new vm.SourceTextModule(payload.code, { context })
  await module.link(() => { throw new Error('component_import_forbidden') })
  await module.evaluate({ timeout: 200 })
  const { run, timeoutMs, failOpen } = module.namespace
  if (typeof run !== 'function') throw new Error('component_run_required')
  if (payload.kind === 'hook' && (failOpen !== true || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000)) throw new Error('invalid_hook_contract')
  timer = setTimeout(() => process.exit(3), payload.kind === 'hook' ? timeoutMs : 4500)
  context.__run = run
  context.__input = JSON.stringify(payload.input)
  // Parsing and serialization both occur inside the VM, including any hostile getters.
  const result = await new vm.Script('Promise.resolve(__run(JSON.parse(__input))).then(x => JSON.stringify(x))').runInContext(context, { timeout: payload.kind === 'hook' ? Math.min(timeoutMs, 200) : 200 })
  clearTimeout(timer)
  if (typeof result !== 'string' || Buffer.byteLength(result) > 24000) throw new Error('component_output_limit')
  process.stdout.write(JSON.stringify({ ok: true, value: JSON.parse(result) }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) }))
  process.exitCode = 1
} finally { clearTimeout(timer) }
