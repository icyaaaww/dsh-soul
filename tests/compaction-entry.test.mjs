import test from 'node:test'
import assert from 'node:assert/strict'

test('public compaction module imports without a host; missing dependency fails only on mount', async () => {
  const entry = await import('../compaction.js')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(entry.name, 'dsh-soul-compaction')
  await assert.rejects(() => entry.apply({}), /无法解析宿主/)
})
