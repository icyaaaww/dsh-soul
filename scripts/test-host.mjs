import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
if (!process.env.DSH_TEST_PACKAGE) throw new Error('设置 DSH_TEST_PACKAGE，指向已安装 DSH 的 package.json')
const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('../tests/host.test.mjs', import.meta.url))], { stdio: 'inherit', env: process.env, windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
