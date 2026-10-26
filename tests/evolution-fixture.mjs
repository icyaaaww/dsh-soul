export const method = title => ({ title, preconditions: ['输入是数字数组'], steps: [title], checks: ['数值升序且无重复，输出 JSON'], counterexamples: ['非数字输入不适用'] })
export const suite = (options = {}) => ({ version: 1, id: 'numbers', title: '数字数组规范化', keywords: ['数字数组'], seed: method('baseline'), auto: false,
  cases: [
    { id: 'duplicates', split: 'train', input: '规范化数字数组 TRAIN_A', files: { 'input.json': '[2,2,3]' }, checks: [{ target: 'file', path: 'result.json', kind: 'jsonEquals', expected: [2,3] }] },
    { id: 'order', split: 'train', input: '规范化数字数组 TRAIN_B', files: { 'input.json': '[10,2]' }, checks: [{ target: 'file', path: 'result.json', kind: 'jsonEquals', expected: [2,10] }] },
    { id: 'holdout-one', split: 'validation', input: '规范化数字数组 HOLDOUT_X', files: { 'input.json': '[30,4,4,-2]' }, checks: [{ target: 'file', path: 'result.json', kind: 'jsonEquals', expected: [-2,4,30] }] },
    { id: 'holdout-two', split: 'validation', input: '规范化数字数组 HOLDOUT_Y', files: { 'input.json': '[12,5,12,1]' }, checks: [{ target: 'file', path: 'result.json', kind: 'jsonEquals', expected: [1,5,12] }] },
  ], ...options })

// A deterministic local model adapter, not a simulated evaluator. The production virtual
// runner executes these read/write actions and independently checks the resulting files.
export function fixtureModel({ overfit = false, regressComposition = false, requests = [], latency = 0 } = {}) {
  let inflight = 0, maxInflight = 0
  const generate = async request => {
    const { phase, data, onUsage } = request
    requests.push(structuredClone({ phase, data })); inflight++; maxInflight = Math.max(maxInflight, inflight)
    try {
      if (latency) await new Promise(resolve => setTimeout(resolve, latency))
      onUsage?.({ inputTokens: 100, outputTokens: 30 })
      if (phase === 'propose') return { candidates: [method('numeric'), method('unique')] }
      if (phase === 'compose') return { strategy: method(regressComposition ? 'baseline' : 'numeric unique'),
        lesson: { cue: '数字数组', lesson: '先按数值排序再去重；仅验证过数字输入', evidence: data.candidates.map(c => c.label) } }
      const last = data.observations.findLast(o => o.type === 'read' && o.path === 'input.json')
      if (!last) return { actions: [{ type: 'read', path: 'input.json' }] }
      let numbers = JSON.parse(last.text)
      const name = data.strategy.steps.join(' ')
      numbers.sort(name.includes('numeric') ? (a, b) => a - b : undefined)
      if (name.includes('unique')) numbers = [...new Set(numbers)]
      if (overfit && data.task.includes('HOLDOUT')) numbers = []
      return { actions: [{ type: 'write', path: 'result.json', text: JSON.stringify(numbers) }, { type: 'finish', answer: '已生成 result.json' }] }
    } finally { inflight-- }
  }
  return { generate, requests, maxInflight: () => maxInflight }
}
