import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const fixtures = JSON.parse(readFileSync('tests/fixtures/releases.json', 'utf8'))
const paths = fixtures.map(({ file, sha256 }) => {
  const path = `tests/fixtures/${file}`
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) throw new Error(`Migration fixture checksum mismatch: ${file}`)
  return path
})
const result = spawnSync(process.execPath, ['scripts/verify-upgrade.mjs', ...paths], { stdio: 'inherit', shell: false })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
