import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Each row is one independently scored task (or task+seed) with all three arms.
// Measurements are supplied by the operator; this reporter makes no model calls.
export function compare({ model, revision, callBudget, learningCalls, cases }) {
  const arms = ['fixed21', 'evolve21', 'evolve22']
  const count = n => Number.isSafeInteger(n) && n >= 0
  if (!model || !revision || !count(callBudget) || !callBudget || !Array.isArray(cases) || !cases.length || learningCalls?.fixed21 !== 0) throw Error('missing experiment metadata or cases')
  const report = {}, seen = new Set()
  for (const arm of arms) {
    if (!count(learningCalls[arm])) throw Error(`invalid learningCalls: ${arm}`)
    report[arm] = { fixed: 0, broken: 0, targetErrorsAvoided: 0, calls: learningCalls[arm] }
  }
  for (const row of cases) {
    if (typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id) || !['transfer', 'control'].includes(row.role)) throw Error('invalid or duplicate case')
    seen.add(row.id)
    for (const arm of arms) {
      const r = row[arm], out = report[arm]
      if (!r || typeof r.passed !== 'boolean' || !count(r.targetErrors) || !count(r.calls)) throw Error(`missing or invalid measurement: ${row.id}/${arm}`)
      if (row.role === 'transfer' && !row.fixed21.passed && r.passed) out.fixed++
      if (row.fixed21.passed && !r.passed) out.broken++
      out.targetErrorsAvoided += row.fixed21.targetErrors - r.targetErrors
      out.calls += r.calls
    }
  }
  if (!cases.some(r => r.role === 'control') || !cases.some(r => r.role === 'transfer')) throw Error('need both transfer and control cases')
  for (const arm of arms) {
    const r = report[arm]
    if (r.calls > callBudget) throw Error(`over agreed budget: ${arm}`)
    r.extraCalls = r.calls - report.fixed21.calls
    r.extraCallsPerFix = r.fixed ? r.extraCalls / r.fixed : null
  }
  return { model, revision, callBudget, cases: cases.length, report }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw Error('usage: node bench/evolution.mjs <measurements.json>')
    console.log(JSON.stringify(compare(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
