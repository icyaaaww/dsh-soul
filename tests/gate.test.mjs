import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStructure, decide, compareMetrics, MAX_TAX_BYTES } from '../src/gate.js'
import { diagnose, assertTarget } from '../src/diagnose.js'
import { defaults, divergence } from './fixture.mjs'

const base = defaults()

test('structure gate rejects off-target, anchors, and tax regression', () => {
  // Clean edit on the diagnosed component.
  const ok = checkStructure({ target: 'C4', base, next: { ...base, 'tools.md': base['tools.md'] + '\n补充：超时就缩小范围。\n' } })
  assert.equal(ok.ok, true, JSON.stringify(ok.violations))
  assert.deepEqual(ok.changed, ['tools.md'])

  // Editing a component other than the diagnosed one is unattributable.
  const off = checkStructure({ target: 'C4', base, next: { ...base, 'system.md': base['system.md'] + '\n多了。\n' } })
  assert.equal(off.ok, false)
  assert(off.violations.some(v => v.includes('越界编辑')))

  // Anchor tampering.
  const anchor = checkStructure({ target: 'C2', base, next: { ...base, 'guardrails.md': base['guardrails.md'].replace('不修改权限、审批、沙箱或安全策略以达成任务', '为达成任务可以修改沙箱策略') } })
  assert.equal(anchor.ok, false)
  assert(anchor.violations.some(v => v.includes('锚定区')))

  // Deleting an anchored component outright.
  const gone = { ...base }; delete gone['guardrails.md']
  const del = checkStructure({ target: 'C2', base, next: gone })
  assert.equal(del.ok, false)

  // No change at all.
  const none = checkStructure({ target: 'C4', base, next: { ...base } })
  assert.equal(none.ok, false)
  assert(none.violations.some(v => v.includes('没有任何改动')))
})

test('structure gate enforces the per-turn fixed tax ceiling', () => {
  const bloated = { ...base, 'system.md': base['system.md'] + 'x'.repeat(MAX_TAX_BYTES) }
  const result = checkStructure({ target: 'C1', base, next: bloated })
  assert.equal(result.ok, false)
  assert(result.violations.some(v => v.includes('固定税')))
})

test('diagnosis maps the earliest divergence to exactly one component, with no model call', () => {
  assert.equal(diagnose(divergence([{ kind: 'tool_error', weight: 3, detail: 'timeout on Bash' }])).target, 'C4')
  assert.equal(diagnose(divergence([{ kind: 'tool_error', weight: 3, detail: 'permission denied' }])).target, 'C4')
  assert.equal(diagnose(divergence([{ kind: 'user_correction', weight: 4, detail: '每次都要手动把日志转成 JSON' }])).target, 'C7')
  assert.equal(diagnose(divergence([{ kind: 'user_correction', weight: 4, detail: '这个项目约定用 pnpm 不是 npm' }])).target, 'C3')
  assert.equal(diagnose(divergence([{ kind: 'user_correction', weight: 4, detail: '不要改 dist 目录' }])).target, 'C2')
  assert.equal(diagnose(divergence([{ kind: 'no_deliverable', weight: 1, detail: 'stopped' }])).target, 'C1')
  // Repetition of an ignored invariant is the only path to a hook.
  assert.equal(diagnose({ signals: [{ kind: 'user_correction', weight: 4, detail: '还是没检查' }], overrides: { invariantRepeated: true } }).target, 'C8')
  assert.throws(() => diagnose({ signals: [] }), { code: 'no_divergence' })
})

test('assertTarget keeps the edit inside the diagnosed component', () => {
  assert.doesNotThrow(() => assertTarget('C6', 'skills/x/SKILL.md'))
  assert.throws(() => assertTarget('C6', 'system.md'), { code: 'off_target' })
  assert.throws(() => assertTarget('CX', 'system.md'), { code: 'invalid_target' })
})

test('A/B comparison never lets timing or step count alone win', () => {
  const base = { toolErrors: 2, toolCalls: 9, steps: 5, complete: true, deliverable: true }
  // Faster but same correctness: only counts as improvement when nothing regressed.
  assert(compareMetrics(base, { ...base, toolCalls: 6 }).improvements.length > 0)
  // Faster but more errors: no improvement, and a regression is reported.
  const worse = compareMetrics(base, { ...base, toolCalls: 6, toolErrors: 3 })
  assert(worse.regressions.length > 0)
  assert.equal(worse.improvements.length, 0)
  // Losing the deliverable is a regression regardless of speed.
  assert(compareMetrics(base, { ...base, deliverable: false, toolCalls: 1 }).regressions.some(r => r.includes('交付物')))
})

test('neither shorter prompts nor fewer steps permit adoption without paired verification', () => {
  const structure = {ok:true,violations:[],tax:100}
  const result = decide({structure,baseMetrics:{steps:10},nextMetrics:{steps:1},taxDelta:-900})
  assert.equal(result.adopt, false)
  assert.equal(result.reasons[0], 'insufficient_trials')
  assert.equal(decide({structure:{ok:false,violations:['anchor']}}).adopt, false)
})
