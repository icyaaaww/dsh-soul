import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = ['tests', 'src/harness-evolution/tests'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort().map(name => `${dir}/${name}`))
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', shell: false })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
