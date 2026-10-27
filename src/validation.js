import { readdir, lstat, readFile } from 'node:fs/promises'
import { resolve, sep, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fail, hash } from './util.js'
import { repoOf, prefixOf, isClean } from './probe.js'

const run = promisify(execFile)
export function validationSettings(input = {}) {
  const trials = input.validationTrials ?? 2
  if (!Number.isInteger(trials) || trials < 2 || trials > 5) throw fail('invalid_validation_trials')
  return { trials, minimumGain: 0.2 }
}

export function normalizeChecks(checks) {
  if (!Array.isArray(checks) || !checks.length) throw fail('verification_required', '需要声明检查实际产物的 checks；没有验收不启动付费演化')
  const names = new Set()
  return checks.map(c => {
    if (!c || typeof c.name !== 'string' || !c.name.trim() || names.has(c.name) || !Array.isArray(c.argv) || !c.argv.length || c.argv.some(a => typeof a !== 'string' || a.includes('\0'))) throw fail('invalid_checks')
    names.add(c.name)
    const protectedPaths = c.protectedPaths ?? []
    if (!Array.isArray(protectedPaths) || protectedPaths.some(p => typeof p !== 'string' || !p || isAbsolute(p) || /[:\\\0]/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..'))) throw fail('invalid_verifier_paths')
    const argv = [...c.argv]
    if (argv[0] === 'node') argv[0] = process.execPath
    // Inline Node verifiers are pinned in configuration. Other commands must declare
    // their test/config dependencies; the agent cannot edit these to award itself a pass.
    const inline = argv[0] === process.execPath && ['-e', '--eval'].includes(argv[1]) && argv.length === 3
    if (!inline && !protectedPaths.length) throw fail('verifier_paths_required', '文件型 checks 必须声明 protectedPaths（测试、配置及其依赖）')
    return { name: c.name, argv, protectedPaths }
  })
}

export async function verifierFingerprint(cwd, checks) {
  const entries = [], base = resolve(cwd)
  let size = 0, count = 0
  const visit = async path => {
    const full = resolve(base, path)
    if (!full.startsWith(base + sep)) throw fail('invalid_verifier_paths')
    // Check every ancestor as well as the leaf: a symlinked directory must not redirect reads.
    let cursor = base
    for (const segment of path.split('/')) {
      cursor = resolve(cursor, segment)
      const st = await lstat(cursor).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
      if (st?.isSymbolicLink()) throw fail('verifier_symlink')
      if (!st) { entries.push([path, 'missing']); return }
    }
    const info = await lstat(full)
    if (++count > 4000) throw fail('verifier_size_limit')
    if (info.isDirectory()) {
      entries.push([path, 'directory'])
      for (const name of (await readdir(full)).sort()) await visit(path + '/' + name)
    } else if (info.isFile()) {
      size += info.size
      if (size > 8_000_000) throw fail('verifier_size_limit')
      entries.push([path, hash((await readFile(full)).toString('base64'))])
    } else throw fail('invalid_verifier_file')
  }
  for (const path of [...new Set(checks.flatMap(c => c.protectedPaths))].sort()) await visit(path)
  return hash(JSON.stringify({ checks, entries }))
}

export async function captureReplay(cwd, checks) {
  checks = normalizeChecks(checks)
  const repo = cwd && await repoOf(cwd)
  if (!repo) throw fail('not_a_repo')
  if (!(await isClean(repo))) throw fail('dirty_worktree')
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeout: 8000, windowsHide: true })
  const revision = stdout.trim(), prefix = await prefixOf(cwd)
  const verifier = await verifierFingerprint(cwd, checks)
  return Object.freeze({ repo, revision, prefix, checks, verifier, identity: hash(JSON.stringify({ revision, prefix, checks, verifier })) })
}

export async function assertVerifier(cwd, replay) {
  if (await verifierFingerprint(cwd, replay.checks) !== replay.verifier) throw fail('verifier_modified', '验收文件或配置已改变，结果作废')
}

const success = run => run?.ok === true && run.metrics?.complete === true && run.checks?.length > 0 && run.checks.every(c => c.ok === true)

/**
 * Classify one paired trial without deciding the episode.
 *
 * The result is deliberately partial: `quality` and `efficiency` say whether this pair
 * contributes a win, not whether the whole episode wins. The orchestrator uses it to stop
 * after a pair that can never be recovered -- once one pair shows neither a quality nor an
 * efficiency gain, "every pair must win" is unreachable, so the remaining arms are pure waste.
 *
 * @returns {{valid:boolean, quality:boolean, efficiency:boolean, reason?:string}}
 */
export function classifyPair({ baseline, candidate }, { minimumGain = 0.2 } = {}) {
  if (!baseline?.verification || baseline.verification !== candidate?.verification) return { valid: false, quality: false, efficiency: false, reason: 'incomparable_runs' }
  if (!baseline.ok || !candidate.ok) return { valid: false, quality: false, efficiency: false, reason: 'probe_failed' }
  if (JSON.stringify(baseline.checks?.map(c => c.name)) !== JSON.stringify(candidate.checks?.map(c => c.name))) return { valid: false, quality: false, efficiency: false, reason: 'incomparable_checks' }
  if (!success(candidate)) return { valid: false, quality: false, efficiency: false, reason: 'candidate_failed_verification' }
  // A baseline that fails the declared checks and a candidate that passes is the strongest
  // evidence available, and it outranks tool-error counts for that pair.
  if (!success(baseline)) return { valid: true, quality: true, efficiency: false }
  const a = baseline.metrics, b = candidate.metrics
  if (b.toolErrors > a.toolErrors) return { valid: true, quality: false, efficiency: false, reason: 'tool_error_regression' }
  // Both arms must pass the same objective checks. No prompt-byte/step-only win.
  const tokenKnown = [a.tokens, b.tokens].every(n => Number.isFinite(n) && n > 0)
  const timeKnown = a.durationMs >= 1000 && b.durationMs > 0
  const tokenWin = tokenKnown && b.tokens <= a.tokens * (1 - minimumGain) && (!timeKnown || b.durationMs <= a.durationMs * 1.1)
  const timeWin = timeKnown && b.durationMs <= a.durationMs * (1 - minimumGain) && tokenKnown && b.tokens <= a.tokens * 1.1
  return { valid: true, quality: false, efficiency: tokenWin || timeWin }
}

export function compareTrials(pairs, { trials = 2, minimumGain = 0.2 } = {}) {
  const reject = reason => ({ ok: false, reason })
  if (!Array.isArray(pairs) || pairs.length < trials || trials < 2) return reject('insufficient_trials')
  let qualityWins = 0, efficiencyWins = 0
  for (const pair of pairs) {
    const verdict = classifyPair(pair, { minimumGain })
    if (!verdict.valid) return reject(verdict.reason)
    if (verdict.reason === 'tool_error_regression') return reject('tool_error_regression')
    if (verdict.quality) qualityWins++
    else if (verdict.efficiency) efficiencyWins++
  }
  if (qualityWins !== pairs.length && efficiencyWins !== pairs.length) return reject('no_repeatable_gain')
  return { ok: true, reason: qualityWins ? 'verified_quality_gain' : 'verified_efficiency_gain', trials: pairs.length, qualityWins, efficiencyWins }
}
