import { entities, isInstance, terms } from './util.js'

// The external-content index stores an inverted list, not a second copy of claims.
// Persistent triggers keep it current even when another writer uses legacy recall.
export function prepareGraphSearch(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='node_terms_fts'").get()) return
  db.exec(`CREATE VIRTUAL TABLE node_terms_fts USING fts5(terms,content='node',content_rowid='rowid');
    CREATE TRIGGER node_terms_ai AFTER INSERT ON node BEGIN
      INSERT INTO node_terms_fts(rowid,terms) VALUES(new.rowid,new.terms); END;
    CREATE TRIGGER node_terms_ad AFTER DELETE ON node BEGIN
      INSERT INTO node_terms_fts(node_terms_fts,rowid,terms) VALUES('delete',old.rowid,old.terms); END;
    CREATE TRIGGER node_terms_au AFTER UPDATE OF terms ON node WHEN old.terms IS NOT new.terms BEGIN
      INSERT INTO node_terms_fts(node_terms_fts,rowid,terms) VALUES('delete',old.rowid,old.terms);
      INSERT INTO node_terms_fts(rowid,terms) VALUES(new.rowid,new.terms); END;
    INSERT INTO node_terms_fts(node_terms_fts) VALUES('rebuild');`)
}

export function rankedCandidates(store, scope, query, limit) {
  const words = terms(query), objects = entities(query).filter(isInstance)
  if (!words.length || limit <= 0) return []
  const paths = objects.filter(x => x.includes('/'))
  const anchors = paths.length ? paths : objects
  const objectTerms = new Set(anchors.flatMap(x => terms(x)))
  const qualifiers = words.filter(x => !objectTerms.has(x))
  // Include exact anchors before LIMIT: dozens of projects can contain a file named index.js.
  const slots = anchors.map(() => '?').join(',')
  const sql = `SELECT n.*, f.rank AS bm FROM node_terms_fts(?) f JOIN node n ON n.rowid=f.rowid
    WHERE n.scope=? AND n.state IN ('active','retired','stale') ${anchors.length ? `AND n.id IN
    (SELECT node FROM mention WHERE scope=? AND entity IN (${slots}))` : ''} ORDER BY f.rank, n.id LIMIT ?`
  const args = [words.map(x => `"${x}"`).join(' OR '), scope, ...(anchors.length ? [scope, ...anchors] : []), Math.max(24, limit * 4)]
  const rows = store.db.prepare(sql).all(...args)
  const accepted = []
  for (const row of rows) {
    const node = store.parseNode(row), own = new Set(node.terms)
    const count = words.reduce((n, x) => n + own.has(x), 0)
    if (!anchors.length && (count < Math.min(2, words.length) || count / words.length < 0.5)) continue
    if (anchors.length && qualifiers.length && !qualifiers.some(x => own.has(x))) continue
    accepted.push({ node, coverage: count / words.length })
  }
  accepted.sort((a, b) => b.coverage - a.coverage || Number(!!a.node.valid_to || a.node.state === 'stale') - Number(!!b.node.valid_to || b.node.state === 'stale') || a.node.bm - b.node.bm || a.node.id.localeCompare(b.node.id))
  return accepted.slice(0, limit).map(x => x.node)
}
