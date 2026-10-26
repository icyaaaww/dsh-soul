import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`)
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', shell: false })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
