'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { LiteratureDiscussionRecovery } = require('./literature-discussion-recovery');
const { backendFingerprint } = require('./literature-runtime');
const PROJECT = path.resolve(__dirname, '..');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-26T10:00:00.000Z', LATER = '2026-10-27T11:00:00.000Z';
const messages = [{ role: 'user', text: '原始研究讨论，保留完整内容。'.repeat(300) }, { role: 'assistant', text: '已有答复必须保留为原片段。' }];
const pair = { at: LATER, question: '这部分怎么核对？', answer: '这是实际存下来的核查问答。' };
function review(overrides = {}) {
  return { schemaVersion: 1, id: A, sessionId: SESSION, workspaceId: 'old-lit', revision: 1, updatedAt: LATER,
    source: JSON.stringify({ messages: [['original-user-id', AT], ['original-assistant-id', LATER]] }), context: { messages }, sourceHistory: [],
    items: [{ id: 'query', discussion: [pair] }, { id: 'sources', discussion: [pair] }],
    config: { query: 'MUST_NOT_BECOME_ACTIVE_CONFIG' }, ready: true, confirmed: 'MUST_NOT_INHERIT_CONFIRMATION', ...overrides };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(PROJECT, '.test-discussion-recovery-'));
  t.after(async () => { assert.equal(path.dirname(root), PROJECT); assert.ok(path.basename(root).startsWith('.test-discussion-recovery-')); await fs.rm(root, { recursive: true, force: true }); });
  const write = async value => { const dir = path.join(root, '.workbench', 'literature-rule-reviews', value.id); await fs.mkdir(dir, { recursive: true }); const file = path.join(dir, 'review.json'); await fs.writeFile(file, JSON.stringify(value)); return file; };
  return { root, write, recovery: new LiteratureDiscussionRecovery(root) };
}

test('saved main contexts and repeated item Q&A deduplicate with exact source review provenance; list is metadata only', async t => {
  const { root, write, recovery } = await fixture(t);
  const first = await write(review()), second = await write(review({ id: B, revision: 2, items: [{ id: 'query', discussion: [pair, { ...pair, at: '2026-10-27T12:00:00.000Z', question: '第二个问题' }] }] }));
  const before = await Promise.all([first, second].map(file => fs.readFile(file, 'utf8')));
  const listed = await recovery.list(); assert.equal(listed.recoveries.length, 1); assert.deepEqual(listed.issues, []);
  const meta = listed.recoveries[0]; assert.equal(meta.messageCount, 2); assert.equal(meta.questionAnswerCount, 2); assert.equal(meta.fragmentCount, 3);
  assert.deepEqual(meta.reviewIds, [A, B]); assert.equal(meta.completeness, 'partial'); assert.match(meta.warning, /非完整聊天/);
  assert.ok(!JSON.stringify(listed).includes(messages[0].text)); assert.ok(!JSON.stringify(listed).includes(pair.question));
  const detail = await new LiteratureDiscussionRecovery(root).get(meta.id);
  const main = detail.fragments.find(item => item.kind === 'main-context');
  assert.equal(main.messages[0].text, messages[0].text); assert.equal(main.messages[0].id, 'original-user-id'); assert.equal(main.messages[0].at, AT);
  assert.deepEqual(main.sources.map(source => source.reviewId), [A, B]);
  const qaSources = detail.fragments.find(item => item.question === pair.question).sources;
  assert.equal(qaSources.length, 3); assert.deepEqual(new Set(qaSources.map(source => source.reviewId)), new Set([A, B]));
  assert.ok(qaSources.some(source => source.itemId === 'sources'));
  assert.ok(!JSON.stringify(detail).includes('MUST_NOT_')); assert.ok(!Object.hasOwn(detail, 'config')); assert.ok(!Object.hasOwn(detail, 'sessionId'));
  assert.deepEqual(await Promise.all([first, second].map(file => fs.readFile(file, 'utf8'))), before);
});

test('old sourceHistory is a named fragment and differing main snapshots are not invented into one conversation', async t => {
  const { write, recovery } = await fixture(t), original = review();
  await write(review({ context: { messages: [{ role: 'user', text: '只有这一条新消息' }] }, source: '{}',
    sourceHistory: [{ at: LATER, revision: 1, context: original.context, source: original.source }] }));
  const meta = (await recovery.list()).recoveries[0], detail = await recovery.get(meta.id);
  const mains = detail.fragments.filter(item => item.kind === 'main-context');
  assert.equal(mains.length, 2); assert.equal(meta.messageCount, 3);
  const old = mains.find(item => item.messages.length === 2); assert.equal(old.sources[0].origin, 'sourceHistory'); assert.equal(old.sources[0].index, 0);
  assert.equal(old.messages[0].id, 'original-user-id'); assert.equal(old.messages[0].at, AT);
});

test('missing, malformed or invalid saved records are reported, never filled with guessed text', async t => {
  const { root, write, recovery } = await fixture(t); await write(review());
  const second = await write(review({ id: B })); await fs.writeFile(second, '{bad json');
  const result = await recovery.list(); assert.equal(result.recoveries.length, 1); assert.deepEqual(result.issues, [{ reviewId: B, code: 'RECOVERY_INVALID_RECORD' }]);
  await fs.unlink(second); assert.equal((await recovery.list()).issues[0].code, 'RECOVERY_MISSING_RECORD');
  await write(review({ id: B, context: { messages: [{ role: 'developer', text: 'Not a saved public discussion role' }] } }));
  assert.equal((await recovery.list()).issues[0].code, 'RECOVERY_INVALID_RECORD');
  await fs.mkdir(path.join(root, '.workbench', 'literature-rule-reviews', 'not-a-review-id')); assert.equal((await recovery.list()).recoveries.length, 1);
});

test('opaque detail IDs reject traversal and other groups remain separate', async t => {
  const { write, recovery } = await fixture(t); await write(review()); await write(review({ id: B, workspaceId: 'another-workspace', context: { messages: [] }, source: '{}' }));
  const result = await recovery.list(); assert.equal(result.recoveries.length, 2); assert.ok(result.recoveries.every(item => /^[a-f0-9]{64}$/.test(item.id)));
  await assert.rejects(recovery.get('../../review.json'), error => error.code === 'RECOVERY_NOT_FOUND');
  await assert.rejects(recovery.get('0'.repeat(64)), error => error.statusCode === 404);
});

test('symlink guards and explicit capacity limits refuse unsafe records without reading their body', async t => {
  const { write, recovery } = await fixture(t), file = await write(review()); const lstat = fs.lstat, readFile = fs.readFile; let reads = 0;
  fs.readFile = async (...args) => { if (args[0] === file) reads++; return readFile(...args); };
  fs.lstat = async (...args) => { const stat = await lstat(...args); return args[0] === file ? { ...stat, isFile: () => true, isSymbolicLink: () => true } : stat; };
  try { await assert.rejects(recovery.list(), error => error.code === 'RECOVERY_UNSAFE_PATH'); assert.equal(reads, 0); }
  finally { fs.lstat = lstat; fs.readFile = readFile; }
  fs.lstat = async (...args) => { const stat = await lstat(...args); return args[0] === file ? { ...stat, size: 33 * 1024 * 1024, isFile: () => true, isSymbolicLink: () => false } : stat; };
  try { await assert.rejects(recovery.list(), error => error.code === 'RECOVERY_CAPACITY' && error.statusCode === 413); }
  finally { fs.lstat = lstat; }
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).id, A);
});

test('an absent review directory is empty, and recovery code is part of runtime fingerprint', async t => {
  const { root, recovery } = await fixture(t); assert.deepEqual((await recovery.list()).recoveries, []);
  const before = backendFingerprint(root); await fs.mkdir(path.join(root, 'tools')); await fs.writeFile(path.join(root, 'tools', 'literature-discussion-recovery.js'), '// fixture');
  assert.notEqual(backendFingerprint(root), before);
});

test('production recovery route is GET-only, metadata/detail separated and does not invoke models or tasks', async t => {
  const { recovery, write } = await fixture(t); await write(review());
  const source = syncFs.readFileSync(path.join(PROJECT, 'server.js'), 'utf8'), start = source.indexOf('async function handleLiterature('), end = source.indexOf('\nfunction normalizeMessages(', start);
  const context = vm.createContext({ literatureDiscussionRecovery: recovery, literatureAuxiliary: { assertIdle() { throw new Error('Do not touch runner'); } }, sendJson(res, status, data) { Object.assign(res, { status, data }); } });
  vm.runInContext(source.slice(start, end), context);
  const call = async suffix => { const res = {}; await context.handleLiterature({ method: 'GET' }, res, new URL('http://fixture/api/literature/discussion-recovery' + suffix)); return res; };
  const listed = await call(''); assert.equal(listed.status, 200); assert.equal(listed.data.recoveries[0].messageCount, 2); assert.ok(!Object.hasOwn(listed.data.recoveries[0], 'fragments'));
  const detail = await call('?id=' + listed.data.recoveries[0].id); assert.equal(detail.status, 200); assert.equal(detail.data.fragments[0].messages[0].text, messages[0].text);
  assert.equal((await call('?id=../bad')).status, 404);
});
