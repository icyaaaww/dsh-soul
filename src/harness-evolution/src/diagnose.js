import { fail } from './util.js'

/**
 * Divergence -> single target component. Zero model calls: this is a table lookup over the
 * earliest observed divergence, which is what keeps the diagnosis step free.
 *
 * The ordering matters. We always pick the EARLIEST divergence and stop, because fixing the
 * earliest one frequently makes later symptoms disappear. Editing two axes at once would make
 * the outcome unattributable, which is the failure mode this plugin exists to avoid.
 */

const RULES = [
  {
    // Explicit caller-supplied evidence outranks every keyword heuristic: a hook may only be
    // proposed after the same invariant has been observed ignored more than once.
    id: 'repeated_invariant',
    when: d => d.overrides?.invariantRepeated === true,
    target: 'C8',
    why: '同一硬约束已多次被忽略，且散文说明已被证明被跳过',
    hint: 'hook 必须 fail-open、声明 timeoutMs、不得阻断合法完成',
  },
  {
    id: 'tool_contract',
    when: d => d.signals.some(s => s.kind === 'tool_error' && /timeout|permission|denied|not found|invalid|unrecogni|参数|超时|权限|不存在/i.test(JSON.stringify(s.detail))),
    target: 'C4',
    why: '工具调用失败源于用法/回退不明，属工具指引',
    hint: '给一个明确的有界回退与停止条件；不要写"重试直到成功"',
  },
  {
    id: 'tool_error_generic',
    when: d => d.signals.some(s => s.kind === 'tool_error'),
    target: 'C4',
    why: '存在工具错误，先修正工具使用指引',
    hint: '区分坏输入、超时、缺能力、权限、未读输出；给出一个回退',
  },
  {
    id: 'mechanical',
    when: d => d.signals.some(s => s.kind === 'user_correction' && /格式|转换|提取|汇总|排序|去重|重复|每次|手动|copy|format|convert|extract|parse/i.test(String(s.detail))),
    target: 'C7',
    why: '确定性的重复机械步骤适合固化为脚本',
    hint: '脚本需声明输入、输出与失败行为；失败要显式报错而不是静默返回空',
  },
  {
    id: 'narrow_workflow',
    // Requires actual sequencing language. A bare "检查" is too weak: it appears in ordinary
    // correctness complaints and would misroute them to a skill.
    when: d => d.signals.some(s => s.kind === 'user_correction') &&
      /流程|步骤|顺序|先.{0,12}再|最后|workflow|checklist|step by step|依次/i.test(String(d.signals.find(s => s.kind === 'user_correction')?.detail ?? '')),
    target: 'C6',
    why: '窄多步流程且有明确触发条件，适合作为可按需加载的技能',
    hint: '技能必须写清触发条件（何时加载），否则永远不会被召回',
  },
  {
    id: 'domain_fact',
    when: d => d.signals.some(s => s.kind === 'user_correction' && /是|应该|不是|其实|约定|规范|版本|实际|actually|convention|should be/i.test(String(s.detail))),
    target: 'C3',
    why: '纠正内容是领域事实/约定，属记忆策略而非流程',
    hint: '记录事实与其适用范围；不要写成通用步骤',
  },
  {
    id: 'guardrail',
    when: d => d.signals.some(s => s.kind === 'user_correction' && /不能|不要|禁止|必须|不得|never|must not|forbidden|security/i.test(String(s.detail))),
    target: 'C2',
    why: '纠正内容是硬约束，属护栏',
    hint: '约束写进锚定区之外的约束段落，保持可判定',
  },
  {
    id: 'no_deliverable',
    when: d => d.signals.some(s => s.kind === 'no_deliverable' || s.kind === 'incomplete' || s.kind === 'truncated'),
    target: 'C1',
    why: '完成度问题，属系统提示中的完成判据',
    hint: '明确"完成"的可观察定义；不要增加领域知识',
  },
]

/** Costs nothing, always returns a target. Ties break toward the earliest, cheapest fix. */
export function diagnose(divergence, { template } = {}) {
  if (!divergence?.signals?.length) throw fail('no_divergence', '没有可归因的分歧，不进化')
  const earliest = [...divergence.signals].sort((a, b) => b.weight - a.weight)[0]
  const input = { signals: divergence.signals, earliest, overrides: divergence.overrides }
  const rule = RULES.find(r => {
    try { return r.when(input) } catch { return false }
  })
  const target = rule?.target ?? template?.target ?? 'C1'
  return {
    rule: rule?.id ?? 'fallback',
    target,
    why: rule?.why ?? '无更具体规则命中，回落到工作方式',
    hint: rule?.hint ?? '只改工作方式与完成判据',
    earliest: earliest.kind,
    signals: divergence.signals.map(s => s.kind),
  }
}

/** Boundary check used by the gate: the editor must stay on the diagnosed component. */
export function assertTarget(target, path) {
  const expected = { C1: 'system.md', C2: 'guardrails.md', C3: 'memory.md', C4: 'tools.md', C5: 'subagents.md', C6: 'skills', C7: 'scripts', C8: 'hooks' }[target]
  if (!expected) throw fail('invalid_target', `未知目标组件 ${target}`)
  if (path !== expected && !path.startsWith(`${expected}/`)) {
    throw fail('off_target', `越界编辑：目标 ${target}(${expected})，实际改动 ${path}`)
  }
  return true
}
