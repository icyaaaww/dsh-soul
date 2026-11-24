import { hash, bounded, isInstance, terms as termSet } from './util.js'

const MAX_MEMBERS = 12
const MAX_LIST = 50
const IGNORED_SYMBOLS = new Set(['api', 'cli', 'http', 'https', 'json', 'jsonl', 'sql', 'tcp', 'udp', 'url', 'utf8', 'xml'])

const symbolNames = claim => {
  const names = new Map()
  // Include explicit code identifiers and names with deliberate internal capitalization;
  // ordinary prose words do not become topics just because they start a sentence.
  for (const match of String(claim ?? '').matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`|\b([A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z]{3,}[A-Z0-9]*)\b/g)) {
    const name = match[1] ?? match[2]
    const key = name.toLowerCase()
    if (name.length >= 3 && !IGNORED_SYMBOLS.has(key)) names.set(key, name)
  }
  return names
}

const pathEntity = value => value.includes('/') && value.split('/').filter(Boolean).length >= 2
const isFileName = value => /^[\w-]+\.[a-z0-9]{1,8}$/i.test(value)
const concreteEntity = value => {
  if (pathEntity(value)) return true
  if (isFileName(value)) return false
  return isInstance(value) && !/^\d+(?:\.\d+)*$/u.test(value)
}
const sourceOf = node => node.session != null && String(node.session) !== '' && Number.isSafeInteger(Number(node.seq)) && Number(node.seq) >= 0
const topicId = (scope, key) => `topic:${hash(`${scope}\u0000${key}`).slice(0, 20)}`

/**
 * Rebuild candidate topic groups from current atomic nodes. This is intentionally a read-time
 * projection: no copied claims or memberships can outlive the source node that justifies them.
 */
function groupsFor(store, scope) {
  if (!scope) return []
  const rows = store.db.prepare(`SELECT n.* FROM node n WHERE n.scope=? AND n.state='active' AND n.valid_to IS NULL
    AND n.session IS NOT NULL ORDER BY n.seen DESC, n.rowid DESC`).all(scope)
  if (!rows.length) return []

  // A correction/supersession edge points from the newer statement to the displaced one. Honor
  // those links even if an older database row did not get its validity interval closed correctly.
  const displaced = new Set(store.db.prepare(`SELECT dst id FROM edge WHERE scope=? AND rel IN ('supersedes','contradicts')`).all(scope).map(row => row.id))
  const nodes = rows.map(row => store.parseNode(row))
    .filter(node => sourceOf(node) && !displaced.has(node.id))

  // If two active artifact records claim the same path but have different fingerprints, keep
  // only the newest assertion. This is a defensive read-time guard for partially migrated data.
  const artifactByPath = new Map()
  for (const node of nodes) {
    if (node.kind !== 'artifact' || !node.anchor?.startsWith('file:')) continue
    const path = node.anchor.slice(5).replaceAll('\\', '/').toLowerCase()
    const previous = artifactByPath.get(path)
    if (!previous || Number(node.seen) > Number(previous.seen) || (node.seen === previous.seen && node.id > previous.id)) artifactByPath.set(path, node)
  }
  const shadowedArtifacts = new Set()
  for (const node of nodes) {
    if (node.kind !== 'artifact' || !node.anchor?.startsWith('file:')) continue
    const path = node.anchor.slice(5).replaceAll('\\', '/').toLowerCase()
    const latest = artifactByPath.get(path)
    if (latest && latest.id !== node.id && latest.hash !== node.hash) shadowedArtifacts.add(node.id)
  }
  const eligible = nodes.filter(node => !shadowedArtifacts.has(node.id))
  const byId = new Map(eligible.map(node => [node.id, node]))
  const candidates = new Map()
  const add = (key, label, node) => {
    let group = candidates.get(key)
    if (!group) candidates.set(key, group = { key, label, members: new Map() })
    group.members.set(node.id, node)
  }

  const mentionMap = new Map()
  for (const row of store.db.prepare('SELECT node, entity FROM mention WHERE scope=?').all(scope)) {
    const entities = mentionMap.get(row.node) ?? new Set()
    entities.add(String(row.entity).toLowerCase())
    mentionMap.set(row.node, entities)
  }
  for (const node of eligible) {
    // Each node's concrete objects are backed by the store's existing mention index.
    for (const entity of mentionMap.get(node.id) ?? []) {
      if (concreteEntity(entity)) add(`entity:${entity}`, entity, node)
    }
    for (const [key, label] of symbolNames(node.claim)) add(`entity:${key}`, label, node)

    // Artifacts in a concrete subdirectory form a useful sibling group; top-level directories
    // such as src/ are intentionally too broad. The exact file entity remains independently
    // discoverable through the mention index.
    if (node.kind === 'artifact' && node.anchor?.startsWith('file:')) {
      const path = node.anchor.slice(5).replaceAll('\\', '/')
      const slash = path.lastIndexOf('/')
      const directory = slash < 0 ? '' : path.slice(0, slash + 1)
      if (directory.split('/').filter(Boolean).length >= 2) add(`dir:${directory.toLowerCase()}`, directory, node)
    }
  }

  const groups = []
  for (const group of candidates.values()) {
    const members = [...group.members.values()].filter(node => byId.has(node.id))
    // Publish only nontrivial groups within the fixed expansion cap.
    if (members.length < 2 || members.length > MAX_MEMBERS) continue
    members.sort((a, b) => String(a.session).localeCompare(String(b.session)) || a.seq - b.seq || a.id.localeCompare(b.id))
    const id = topicId(scope, group.key)
    groups.push({ id, label: group.label, count: members.length, key: group.key, members })
  }
  return groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/** Compute current topics without persisting a second, potentially stale representation. */
export function maintainTopics(store, scope) {
  return groupsFor(store, scope).length
}

/** List current, concrete groups. Results and individual expansions are deliberately bounded. */
export function listTopics(store, scope, query = '', limit = 8) {
  const text = String(query ?? '').trim().toLowerCase()
  const wanted = new Set(termSet(text))
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(MAX_LIST, Math.floor(Number(limit)))) : 8
  const groups = groupsFor(store, scope)
  const exact = text ? groups.filter(group => group.label.toLowerCase() === text) : []
  if (exact.length) return exact.slice(0, max).map(({ id, label, count }) => ({ id, label, count }))
  if (!max) return []
  return groups
    .filter(group => {
      if (!text) return true
      if (group.label.toLowerCase().includes(text)) return true
      const labelTerms = new Set(termSet(group.label))
      let shared = 0
      for (const term of wanted) if (labelTerms.has(term)) shared++
      if (wanted.size && shared / wanted.size >= 0.5) return true
      return group.members.some(node => node.claim.toLowerCase().includes(text))
    })
    .slice(0, max)
    .map(({ id, label, count }) => ({ id, label, count }))
}

/** Expand one still-current topic and dereference each node's exact session/seq source. */
export function expandTopic(store, scope, id) {
  if (typeof id !== 'string' || !id) return null
  const group = groupsFor(store, scope).find(topic => topic.id === id)
  if (!group) return null
  const members = group.members.slice(0, MAX_MEMBERS).map(node => {
    const session = String(node.session)
    const seq = Number(node.seq)
    const span = store.spanAt(scope, session, seq)
    return {
      id: node.id,
      claim: node.claim,
      kind: node.kind,
      session,
      seq,
      excerpt: span && span.session === session && Number(span.seq) === seq ? bounded(span.text, 240) : null,
    }
  })
  return { id: group.id, label: group.label, members }
}

export const TOPIC_MEMBER_LIMIT = MAX_MEMBERS
