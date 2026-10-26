import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { installTree, probe } from '../src/probe.js'
import { hostProbe } from '../src/host-probe.js'
import { fail } from '../src/util.js'

test('candidate keeps project subdirectory; checks see its artifacts before cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolve-subdir-'))
  const aliasRoot = mkdtempSync(join(tmpdir(), 'evolve-alias-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
  let candidate
  try {
    git('init', '-q'); mkdirSync(join(dir, 'project')); writeFileSync(join(dir, 'project', 'source.txt'), 'source')
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
    const execute = hostProbe({ spawn: async ({ cwd, files }) => {
      candidate = cwd
      assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'source')
      assert.equal(readFileSync(join(cwd, '.dsh-soul', 'harness', 'memory.md'), 'utf8'), files['memory.md'])
      writeFileSync(join(cwd, 'result.txt'), 'ok')
      return { steps: 1, toolCalls: 1, toolErrors: 0, complete: true, durationMs: 1 }
    } })
    const input = { root: join(dir, 'project'), files: { 'memory.md': 'candidate' }, signal: new AbortController().signal,
      checks: [{ name: 'artifact', argv: [process.execPath, '-e', "require('fs').readFileSync('result.txt')"] }] }
    const result = await execute(input)
    assert.equal(result.metrics.deliverable, true)
    assert.equal(existsSync(candidate), false); assert.equal(git('status', '--porcelain'), '')
    const alias = join(aliasRoot, 'project-alias')
    symlinkSync(join(dir, 'project'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliased = await execute({ ...input, root: alias })
    assert.equal(aliased.metrics.deliverable, true)
    assert.equal(existsSync(candidate), false)
    assert.equal(existsSync(join(dir, 'project', 'result.txt')), false)
    assert.equal(git('status', '--porcelain'), '')
    writeFileSync(join(dir, 'uncommitted.txt'), 'dirty')
    await assert.rejects(() => execute.preflight({ cwd: dir, parent: {} }), error => error.code === 'dirty_worktree')
  } finally { rmSync(aliasRoot, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})

test('harness writes refuse path escapes and directory junctions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolve-links-'))
  const outside = mkdtempSync(join(tmpdir(), 'evolve-outside-'))
  try {
    await assert.rejects(() => installTree(dir, { 'memory.md': 'x' }, { folder: '../outside' }), /invalid_path/)
    await assert.rejects(() => installTree(dir, { '../memory.md': 'x' }), error => error.code === 'invalid_path')
    symlinkSync(outside, join(dir, '.dsh-soul'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => installTree(dir, { 'memory.md': 'x' }), error => error.code === 'symlink')
    assert.equal(existsSync(join(outside, 'harness')), false)
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('probe refuses invented metrics and preserves cancellation reason', async () => {
  const invalid = await probe({ execute: async () => ({ metrics: { complete: true } }) })
  assert.equal(invalid.ok, false); assert.equal(invalid.reason, 'invalid_probe_metrics')
  const controller = new AbortController()
  const cancelled = await probe({ signal: controller.signal, execute: async () => {
    controller.abort(fail('cancelled')); throw fail('some_other_error')
  } })
  assert.equal(cancelled.ok, false); assert.equal(cancelled.reason, 'cancelled')
})
