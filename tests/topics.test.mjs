import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.js'
import { expandTopic, listTopics, maintainTopics, TOPIC_MEMBER_LIMIT } from '../src/topics.js'

const span = (seq, session, text) => ({ seq, session, kind: 'user/message', text, hash: `${session}:${seq}` })
const sourceNode = (id, claim, session, seq, over = {}) => ({ id, kind: 'progress', claim, session, seq, ...over })

function topicByLabel(store, scope, label) {
  return listTopics(store, scope, '', 50).find(topic => topic.label === label) ?? null
}

test('topics are read-time groups over sourced nodes and expansion dereferences each session span', t => {
  const store = new Store(':memory:')
  t.after(() => store.close())
  store.recordNodes('project-a', { nodes: [
    sourceNode('login-decision', '决定完善 src/auth/login.js 的登录校验。', 'session-one', 2, { kind: 'decision' }),
    sourceNode('login-progress', 'src/auth/login.js 的登录校验已经完成。', 'session-two', 8),
    sourceNode('session-artifact', 'src/auth/session.js 已写入', 'session-three', 4,
      { kind: 'artifact', anchor: 'file:src/auth/session.js', hash: 'fingerprint-session' }),
    sourceNode('token-artifact', 'src/auth/token.js 已写入', 'session-four', 9,
      { kind: 'artifact', anchor: 'file:src/auth/token.js', hash: 'fingerprint-token' }),
    sourceNode('unsourced-login', 'src/auth/login.js 的旁支观察，没有会话来源', null, 10),
  ] })
  store.putSpans('project-a', 'session-one', [span(2, 'session-one', '原始登录决策来自第一个会话。')])
  store.putSpans('project-a', 'session-two', [span(8, 'session-two', '原始登录进度来自另一个会话。')])

  const before = store.db.prepare('SELECT COUNT(*) n, SUM(hits) hits, SUM(support) support FROM node WHERE scope=?').get('project-a')
  assert.equal(maintainTopics(store, 'project-a'), listTopics(store, 'project-a', '', 50).length)
  const login = topicByLabel(store, 'project-a', 'src/auth/login.js')
  assert.equal(login.count, 2)
  assert.deepEqual(listTopics(store, 'project-a', 'login.js').map(topic => topic.label), ['src/auth/login.js'])
  const expanded = expandTopic(store, 'project-a', login.id)
  assert.equal(expanded.members.length, 2)
  assert.deepEqual(expanded.members.map(member => [member.session, member.seq]), [['session-one', 2], ['session-two', 8]])
  assert.match(expanded.members[0].excerpt, /第一个会话/)
  assert.match(expanded.members[1].excerpt, /另一个会话/)

  const directory = topicByLabel(store, 'project-a', 'src/auth/')
  assert.equal(directory.count, 2)
  assert.deepEqual(expandTopic(store, 'project-a', directory.id).members.map(member => member.id).sort(), ['session-artifact', 'token-artifact'])
  const after = store.db.prepare('SELECT COUNT(*) n, SUM(hits) hits, SUM(support) support FROM node WHERE scope=?').get('project-a')
  assert.deepEqual(after, before, 'topic reads must not rewrite or reinforce atomic memories')
  assert.equal(listTopics(store, 'project-b').length, 0, 'topics never cross project scopes')
})

test('topic expansion returns a bounded excerpt or null and rechecks current membership', t => {
  const store = new Store(':memory:')
  t.after(() => store.close())
  store.recordNodes('p', { nodes: [
    sourceNode('a', 'src/cache.js 已确认缓存策略。', 's1', 1),
    sourceNode('b', '正在验证 src/cache.js 的缓存策略。', 's2', 2),
    sourceNode('c', 'src/cache.js 的第三项验证已完成。', 's3', 3),
  ] })
  store.putSpans('p', 's1', [span(1, 's1', 'x'.repeat(600))])
  const topic = topicByLabel(store, 'p', 'src/cache.js')
  assert.equal(topic.count, 3)
  const result = expandTopic(store, 'p', topic.id)
  assert.equal(result.members[0].excerpt.length, 240)
  assert.equal(Buffer.byteLength(result.members[0].excerpt), 240)
  assert.equal(result.members.find(member => member.id === 'b').excerpt, null)
  assert.equal(result.members.find(member => member.id === 'c').excerpt, null)

  store.db.prepare("UPDATE node SET state='stale' WHERE id='b'").run()
  const refreshed = expandTopic(store, 'p', topic.id)
  assert.deepEqual(refreshed.members.map(member => member.id).sort(), ['a', 'c'], 'stale membership is removed on each read')
  assert.equal(expandTopic(store, 'p', 'not-a-topic'), null)
})

test('superseded, contradicted, stale, retired, and expired atoms cannot appear as current members', t => {
  const store = new Store(':memory:')
  t.after(() => store.close())
  store.recordNodes('p', {
    nodes: [
      sourceNode('current-one', 'src/cache.js 的缓存策略已复核。', 's', 1),
      sourceNode('current-two', 'src/cache.js 的缓存策略通过验证。', 's', 2),
      sourceNode('superseded', 'src/cache.js 以前使用旧缓存策略。', 's', 3),
      sourceNode('contradicted', 'src/cache.js 曾使用错误缓存策略。', 's', 4),
      sourceNode('stale', 'src/cache.js 的缓存状态已经变化。', 's', 5),
      sourceNode('retired', 'src/cache.js 的缓存状态已退役。', 's', 6),
      sourceNode('expired', 'src/cache.js 的缓存状态已结束。', 's', 7),
    ],
    edges: [
      { src: 'current-one', dst: 'superseded', rel: 'supersedes' },
      { src: 'current-two', dst: 'contradicted', rel: 'contradicts' },
    ],
  })
  store.db.prepare("UPDATE node SET state='stale' WHERE id='stale'").run()
  store.db.prepare("UPDATE node SET state='retired' WHERE id='retired'").run()
  store.db.prepare('UPDATE node SET valid_to=? WHERE id=?').run(Date.now(), 'expired')

  const topic = topicByLabel(store, 'p', 'src/cache.js')
  assert.equal(topic.count, 2)
  assert.deepEqual(expandTopic(store, 'p', topic.id).members.map(member => member.id).sort(), ['current-one', 'current-two'])
})

test('groups and list limits stay bounded', t => {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const nodes = Array.from({ length: TOPIC_MEMBER_LIMIT + 1 }, (_, index) =>
    sourceNode(`member-${index}`, `src/large/shared.js has observation ${index}`, 'session', index))
  store.recordNodes('p', { nodes })
  assert.equal(topicByLabel(store, 'p', 'src/large/shared.js'), null, 'high-fan groups are not promoted as topics')
  assert.ok(listTopics(store, 'p', '', 1000).length <= 50)
  assert.deepEqual(listTopics(store, 'p', '', 0), [])
})
