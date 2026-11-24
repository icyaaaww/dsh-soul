import assert from 'node:assert/strict'
import { Store } from '../src/store.js'

// Compare two lossless encodings of the same bitemporal, role-bearing facts:
// (1) the current node/edge schema, using one assertion node and role-labelled edges;
// (2) one fact row plus role/value rows, with explicit valid-time and system-time intervals.
// No LLM, embeddings, or network calls are involved.
const DAY = 86_400_000
const T0 = 1_700_000_000_000
const GROUPS = Number(process.env.TEMPORAL_GROUPS ?? 512)
assert.ok(Number.isSafeInteger(GROUPS) && GROUPS >= 2, 'TEMPORAL_GROUPS must be an integer >= 2 for cross-event negatives')
const SCOPE = 'temporal-bench'
const PREDICATE = 'build_result'
const ROLES = ['actor', 'artifact', 'task', 'workspace']
const VERSION = [
  { status: 'queued', validFrom: 0, validTo: 1, systemFrom: 0, systemTo: null },
  { status: 'passed', validFrom: 1, validTo: 3, systemFrom: 1, systemTo: 4 },
  { status: 'failed', validFrom: 1, validTo: 3, systemFrom: 4, systemTo: null, supersedes: 1 },
  { status: 'rolled_back', validFrom: 3, validTo: null, systemFrom: 5, systemTo: null },
]
const at = days => T0 + days * DAY
const entityId = (role, value) => `entity:${role}:${value}`

const events = []
const entities = new Map()
const graphNodes = []
const graphEdges = []
const roleRows = []
const factRows = []
for (let group = 0; group < GROUPS; group++) {
  const args = {
    actor: `agent-${group}`,
    artifact: `src/module-${group}.js`,
    task: `issue-${group}`,
    workspace: `repo-${group % 16}`,
  }
  for (const role of [...ROLES, 'status']) {
    const values = role === 'status' ? ['queued', 'passed', 'failed', 'rolled_back'] : [args[role]]
    for (const value of values) {
      const id = entityId(role, value)
      if (entities.has(id)) continue
      entities.set(id, { id, role, value })
      graphNodes.push({ id, kind: 'reference', claim: value })
    }
  }
  for (let version = 0; version < VERSION.length; version++) {
    const spec = VERSION[version]
    const id = `event-${group}-${version}`
    const record = {
      id, group, version, args, status: spec.status,
      validFrom: at(group * 10 + spec.validFrom),
      validTo: spec.validTo === null ? null : at(group * 10 + spec.validTo),
      systemFrom: at(group * 10 + spec.systemFrom),
      systemTo: spec.systemTo === null ? null : at(group * 10 + spec.systemTo),
      session: `session-${group % 32}`,
      seq: group * VERSION.length + version,
    }
    events.push(record)
    graphNodes.push({
      id, kind: 'decision', claim: `${PREDICATE} ${spec.status}`,
      session: record.session, seq: record.seq,
    })
    const roleValues = { ...args, status: spec.status }
    for (const [role, value] of Object.entries(roleValues)) {
      graphEdges.push({ src: id, dst: entityId(role, value), rel: role, w: 1 })
      roleRows.push({ fact: id, role, value })
    }
    if (spec.supersedes != null) {
      graphEdges.push({ src: id, dst: `event-${group}-${spec.supersedes}`, rel: 'supersedes', w: 1 })
    }
    factRows.push(record)
  }
}

const store = new Store(':memory:', { now: () => T0, maxNodes: graphNodes.length + 1 })
try {
  store.recordNodes(SCOPE, { nodes: graphNodes, edges: graphEdges })
  const setTime = store.db.prepare(`UPDATE node SET created=?, recorded_at=?, valid_from=?, valid_to=? WHERE id=?`)
  for (const event of events) setTime.run(event.systemFrom, event.systemFrom, event.validFrom, event.validTo, event.id)
  store.db.exec(`UPDATE edge SET created=(SELECT recorded_at FROM node WHERE node.id=edge.src)
    WHERE scope='${SCOPE}'`)

  store.db.exec(`
    CREATE TABLE temporal_fact (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, predicate TEXT NOT NULL,
      valid_from INTEGER NOT NULL, valid_to INTEGER,
      system_from INTEGER NOT NULL, system_to INTEGER,
      session TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE temporal_role (
      scope TEXT NOT NULL, fact TEXT NOT NULL REFERENCES temporal_fact(id),
      role TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(scope, fact, role)
    );
    CREATE INDEX temporal_fact_lookup ON temporal_fact(scope, predicate, valid_from, system_from);
    CREATE INDEX temporal_role_lookup ON temporal_role(scope, role, value, fact);
  `)
  const insertFact = store.db.prepare(`INSERT INTO temporal_fact
    (id,scope,predicate,valid_from,valid_to,system_from,system_to,session,seq,status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const insertRole = store.db.prepare('INSERT INTO temporal_role(scope,fact,role,value) VALUES (?,?,?,?)')
  store.tx(() => {
    for (const event of factRows) {
      insertFact.run(event.id, SCOPE, PREDICATE, event.validFrom, event.validTo,
        event.systemFrom, event.systemTo, event.session, event.seq, event.status)
      for (const [role, value] of Object.entries({ ...event.args, status: event.status })) {
        insertRole.run(SCOPE, event.id, role, value)
      }
    }
  })

  const graphQuery = store.db.prepare(`SELECT n.id, status_node.claim AS status
    FROM edge a CROSS JOIN node n ON n.id=a.src AND n.scope=a.scope
    JOIN edge status_edge ON status_edge.scope=n.scope AND status_edge.src=n.id AND status_edge.rel='status'
    JOIN node status_node ON status_node.id=status_edge.dst
    WHERE n.scope=? AND n.kind='decision' AND n.valid_from<=? AND (n.valid_to IS NULL OR n.valid_to>?)
      AND n.recorded_at<=?
      AND a.rel='actor' AND a.dst=?
      AND EXISTS (SELECT 1 FROM edge e WHERE e.scope=n.scope AND e.src=n.id AND e.rel='artifact' AND e.dst=?)
      AND EXISTS (SELECT 1 FROM edge e WHERE e.scope=n.scope AND e.src=n.id AND e.rel='task' AND e.dst=?)
      AND EXISTS (SELECT 1 FROM edge e WHERE e.scope=n.scope AND e.src=n.id AND e.rel='workspace' AND e.dst=?)
      AND NOT EXISTS (
        SELECT 1 FROM edge s JOIN node newer ON newer.id=s.src
        WHERE s.scope=n.scope AND s.rel='supersedes' AND s.dst=n.id AND newer.recorded_at<=?
      )
    ORDER BY n.recorded_at DESC, n.id DESC LIMIT 2`)
  const hyperQuery = store.db.prepare(`SELECT f.id, f.status
    FROM temporal_role a CROSS JOIN temporal_fact f ON f.id=a.fact AND f.scope=a.scope
    WHERE f.scope=? AND f.predicate=? AND f.valid_from<=? AND (f.valid_to IS NULL OR f.valid_to>?)
      AND f.system_from<=? AND (f.system_to IS NULL OR f.system_to>?)
      AND a.role='actor' AND a.value=?
      AND EXISTS (SELECT 1 FROM temporal_role r WHERE r.scope=f.scope AND r.fact=f.id AND r.role='artifact' AND r.value=?)
      AND EXISTS (SELECT 1 FROM temporal_role r WHERE r.scope=f.scope AND r.fact=f.id AND r.role='task' AND r.value=?)
      AND EXISTS (SELECT 1 FROM temporal_role r WHERE r.scope=f.scope AND r.fact=f.id AND r.role='workspace' AND r.value=?)
    ORDER BY f.system_from DESC, f.id DESC LIMIT 2`)

  const queries = []
  for (let group = 0; group < GROUPS; group++) {
    const args = {
      actor: `agent-${group}`,
      artifact: `src/module-${group}.js`,
      task: `issue-${group}`,
      workspace: `repo-${group % 16}`,
    }
    const cases = [
      { valid: group * 10 + 2, known: group * 10 + 2.5, expected: `event-${group}-1`, status: 'passed', name: 'original view' },
      { valid: group * 10 + 2, known: group * 10 + 4.5, expected: `event-${group}-2`, status: 'failed', name: 'retroactive correction' },
      { valid: group * 10 + 3.5, known: group * 10 + 4.5, expected: null, status: null, name: 'not yet known' },
      { valid: group * 10 + 3.5, known: group * 10 + 5.5, expected: `event-${group}-3`, status: 'rolled_back', name: 'later state' },
    ]
    for (const sample of cases) queries.push({ ...sample, args, validAt: at(sample.valid), knownAt: at(sample.known) })
    queries.push({
      name: 'cross-event role mismatch', args: { ...args, artifact: `src/module-${(group + 1) % GROUPS}.js` },
      validAt: at(group * 10 + 2), knownAt: at(group * 10 + 2.5), expected: null, status: null,
    })
  }

  const run = (query, statement) => {
    const { args, validAt, knownAt } = query
    const values = ROLES.map(role => args[role])
    const rows = statement === graphQuery
      ? statement.all(SCOPE, validAt, validAt, knownAt, ...ROLES.map((role, i) => entityId(role, values[i])), knownAt)
      : statement.all(SCOPE, PREDICATE, validAt, validAt, knownAt, knownAt, ...values)
    return rows
  }
  const measure = statement => {
    for (const query of queries.slice(0, 100)) run(query, statement)
    const samples = []
    let correct = 0, multiple = 0
    const mismatches = []
    for (const query of queries) {
      const start = process.hrtime.bigint()
      const rows = run(query, statement)
      samples.push(Number(process.hrtime.bigint() - start) / 1e3)
      if (rows.length > 1) multiple++
      if ((rows[0]?.id ?? null) === query.expected && (rows[0]?.status ?? null) === query.status) correct++
      else if (mismatches.length < 4) mismatches.push({ name: query.name, expected: query.expected, status: query.status, actual: rows[0] ?? null })
    }
    samples.sort((a, b) => a - b)
    const percentile = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
    return {
      exact: `${correct}/${queries.length}`,
      multipleMatches: multiple,
      meanUs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
      p50Us: Number(percentile(0.5).toFixed(2)),
      p95Us: Number(percentile(0.95).toFixed(2)),
      ...(mismatches.length ? { mismatches } : {}),
    }
  }

  const graphCurrent = measure(graphQuery)
  store.db.exec(`CREATE INDEX bench_edge_role ON edge(scope,rel,dst,src);
    CREATE INDEX bench_event_time ON node(scope,kind,valid_from,valid_to,recorded_at);`)
  const graphIndexed = measure(graphQuery)
  const temporalHyper = measure(hyperQuery)
  const pages = store.db.prepare(`SELECT d.name, s.tbl_name AS owner, SUM(d.pgsize) AS bytes
    FROM dbstat d JOIN sqlite_schema s ON s.name=d.name GROUP BY d.name,s.tbl_name`).all()
  const bytesFor = predicate => pages.filter(predicate).reduce((sum, row) => sum + row.bytes, 0)
  const graphObject = row => /^(node|edge|mention)(_|$)/.test(row.owner)
  const summary = {
    fixture: { groups: GROUPS, facts: events.length, queries: queries.length, rolesPerFact: ROLES.length + 1 },
    rows: {
      graph: { assertionAndEntityNodes: graphNodes.length, roleAndSupersessionEdges: graphEdges.length, sqliteBytes: bytesFor(row => graphObject(row) && !row.name.startsWith('bench_')) },
      graphWithRoleTimeIndexes: { sqliteBytes: bytesFor(graphObject) },
      temporalHyperrelation: { facts: factRows.length, roleValues: roleRows.length, sqliteBytes: bytesFor(row => row.owner === 'temporal_fact' || row.owner === 'temporal_role') },
    },
    retrieval: { currentGraphIndexes: graphCurrent, graphWithRoleTimeIndexes: graphIndexed, temporalHyperrelation: temporalHyper },
  }
  console.log(JSON.stringify(summary, null, 2))
  assert.equal(graphCurrent.exact, `${queries.length}/${queries.length}`, 'current graph encoding must preserve role and time answers')
  assert.equal(graphIndexed.exact, `${queries.length}/${queries.length}`, 'indexed graph encoding must preserve all answers')
  assert.equal(temporalHyper.exact, `${queries.length}/${queries.length}`, 'hyperrelation encoding must preserve all answers')
  assert.equal(graphCurrent.multipleMatches, 0)
  assert.equal(graphIndexed.multipleMatches, 0)
  assert.equal(temporalHyper.multipleMatches, 0)
} finally {
  store.close()
}
