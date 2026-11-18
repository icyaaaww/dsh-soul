import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

const dir = mkdtempSync(join(tmpdir(), 'soul-disk-'))
const node = (i, revision = 1) => ({ id: `n${i}`, kind: 'decision', claim: `模块 src/m${i}/config.js 的连接池上限为 ${revision * 11 + i % 27}，服务名称 worker${i % 41}` })
const median = xs => { const s = [...xs].sort((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2 }
const timed = fn => { const t = performance.now(); fn(); return performance.now() - t }
const rows = []
const seed = join(dir, 'seed.db')
let store
try {
  store = new Store(seed, { maxNodes: 2000 })
  store.recordNodes('p', { nodes: Array.from({length: 1000}, (_, i) => node(i)) })
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.close(); store = null
  for (let trial = 0; trial < 6; trial++) {
    for (const ranked of trial % 2 ? [true,false] : [false,true]) {
      const path = join(dir, `${trial}-${ranked}.db`)
      copyFileSync(seed, path)
      const open = timed(() => { store = new Store(path, { maxNodes: 2000, rankedRecall: ranked }) })
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      // Capture WAL growth without log recycling, both arms under the same setting.
      store.db.exec('PRAGMA wal_autocheckpoint=0')
      const writes = timed(() => {
        for (let i = 0; i < 200; i++) store.recordNodes('p', { nodes: [i % 2 ? node(i, 2) : node(1000 + i)] })
      })
      const wal = statSync(path + '-wal').size
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.close(); store = null
      rows.push({ trial, ranked, open, writes, wal, bytes: statSync(path).size })
    }
  }
  const summary = Object.fromEntries([false,true].map(ranked => [ranked ? 'fts' : 'legacy', Object.fromEntries(['open','writes','wal','bytes'].map(k => [k,median(rows.filter(r => r.ranked === ranked).map(r => r[k]))]))]))
  console.log(JSON.stringify({ node: process.version, platform: process.platform, summary, rows }, null, 2))
} finally { store?.close(); rmSync(dir, { recursive: true, force: true }) }
