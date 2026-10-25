import { Store } from '../src/store.js'
import { Evolution, evolutionSettings } from '../src/evolution.js'
import { fixtureModel, suite } from '../tests/evolution-fixture.mjs'

const store = new Store(':memory:'), model = fixtureModel()
const engine = new Evolution(store, model.generate, evolutionSettings({ evolution: true, provider: 'local-fixture', model: 'deterministic' }))
try {
  engine.register('demo', suite())
  const started = engine.start('demo', 'numbers', 'demo-session'); await engine.running
  const run = engine.inspect('demo', started.id)
  console.log(JSON.stringify({ note: 'Offline deterministic model fixture; real virtual file actions and fixed validation. No API calls, not real-model learning performance.',
    state: run.state, rounds: run.round, stages: run.probes.map(p => ({ label: p.label, split: p.split, passed: p.results.filter(r => r.pass).length, total: p.results.length })),
    summary: run.summary, adoptedSkill: run.memory ? JSON.parse(store.get(run.memory, 'demo').text) : null }, null, 2))
  if (run.state !== 'adopted') process.exitCode = 1
} finally { await engine.stop(); store.close() }
