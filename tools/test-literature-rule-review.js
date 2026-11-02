'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { LiteratureRuleReviewStore, ITEMS, GROUPS, MAX_REVIEW_CONTEXT_BYTES } = require('./literature-rule-review');
const { normalizeConfig } = require('./literature-config');

function config(extra = {}) {
  return { topic: '温度对畜禽生产的影响', query: 'cattle AND temperature', sources: ['google-scholar'], publicationYearFrom: 2000,
    publicationYearTo: 2026, language: '中文、英文', geography: '全球', studyTypes: ['期刊论文', '学位论文'],
    inclusion: ['目标气候因素影响可分离'], exclusion: ['动物呼吸CO2'], searchMode: 'formal', stopMode: 'end',
    targetFields: ['生长', '饲料效率'], ...extra };
}
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(path.resolve(__dirname, '..'), '.test-literature-rule-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LiteratureRuleReviewStore(root), sessionId = crypto.randomUUID();
  const review = await store.create({ sessionId, workspaceId: 'project-1', config: config(extra), until: 'discover', source: 'discussion-v1',
    context: { messages: [{ role: 'user', text: '2000年至实际检索日，正式检索。' }], approvedDoc: '已经确认的范围' } });
  return { root, store, sessionId, review };
}
async function confirmAll(store, sessionId, original) {
  let review = original;
  for (const group of GROUPS) review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'group-confirm', groupId: group.id });
  return review;
}

test('all normalized keys belong to one stable item; config and Unicode evidence round-trip', async t => {
  const { root, store, sessionId, review } = await fixture(t);
  assert.equal(review.items.length, 14);
  assert.ok(GROUPS.every(group => group.itemIds.length >= 3 && group.itemIds.length <= 5));
  assert.equal(new Set(ITEMS.flatMap(item => item.keys)).size, ITEMS.flatMap(item => item.keys).length);
  assert.deepEqual(review.config, normalizeConfig(config()));
  assert.deepEqual(Object.keys(review.config).sort(), review.items.flatMap(item => Object.keys(item.value)).filter(key => key !== 'until').sort());
  assert.equal(review.ready, false);
  assert.deepEqual(review.progress, { total: 14, confirmed: 0 });
  const restored = await new LiteratureRuleReviewStore(root).get(review.id, sessionId);
  assert.deepEqual(restored, review);
  assert.equal(restored.context.messages[0].text, '2000年至实际检索日，正式检索。');
  assert.equal(restored.until, 'discover');
  await assert.rejects(store.get('../escape', sessionId), /标识无效/);
});

test('human confirm, edit and re-confirm keep history and persist independently of caller objects', async t => {
  const { root, store, sessionId, review } = await fixture(t);
  const confirmed = await store.act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: 'years' });
  assert.equal(confirmed.items.find(item => item.id === 'years').status, 'confirmed');
  const changed = await store.act({ id: review.id, sessionId, revision: confirmed.revision, action: 'edit', itemId: 'years', value: { publicationYearFrom: 2001, publicationYearTo: 2026 } });
  const item = changed.items.find(entry => entry.id === 'years');
  assert.equal(item.status, 'pending'); assert.equal(item.version, 2);
  assert.ok(item.history.some(entry => entry.status === 'confirmed' && entry.value.publicationYearFrom === 2000));
  changed.config.topic = '修改客户端副本不能改服务端';
  const restored = await new LiteratureRuleReviewStore(root).get(review.id, sessionId);
  assert.equal(restored.config.publicationYearFrom, 2001);
  assert.equal(restored.config.topic, review.config.topic);
  const next = await store.act({ id: review.id, sessionId, revision: restored.revision, action: 'confirm', itemId: 'years' });
  assert.equal(next.items.find(entry => entry.id === 'years').status, 'confirmed');
});

test('task ownership and optimistic revision reject stale or cross-session changes without file loss', async t => {
  const { root, store, sessionId, review } = await fixture(t);
  const file = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  const original = await fs.readFile(file, 'utf8');
  await assert.rejects(store.get(review.id, crypto.randomUUID()), error => error.code === 'REVIEW_SESSION_MISMATCH');
  await assert.rejects(store.act({ id: review.id, sessionId: crypto.randomUUID(), revision: 1, action: 'confirm', itemId: 'topic' }), /不属于/);
  await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'edit', itemId: 'years', value: { publicationYearFrom: 2028, publicationYearTo: 2000 } }), /年份/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const results = await Promise.allSettled([
    store.act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: 'topic' }),
    new LiteratureRuleReviewStore(root).act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: 'years' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVIEW_REVISION_CONFLICT');
  const restored = await store.get(review.id, sessionId); assert.equal(restored.revision, 2);
});

test('execution requires every item confirmed, a current revision and exactly the confirmed config and until', async t => {
  const { store, sessionId, review } = await fixture(t);
  await assert.rejects(store.execution({ id: review.id, sessionId, workspaceId: review.workspaceId, revision: 1, config: review.config, until: 'discover' }), error => error.code === 'REVIEW_NOT_READY');
  const done = await confirmAll(store, sessionId, review);
  assert.equal(done.ready, true); assert.equal(done.progress.confirmed, 14);
  await assert.rejects(store.execution({ id: done.id, sessionId, workspaceId: done.workspaceId, revision: 1, config: done.config, until: done.until }), /旧版本/);
  await assert.rejects(store.execution({ id: done.id, sessionId, workspaceId: done.workspaceId, revision: done.revision, config: { ...done.config, query: 'changed' }, until: done.until }), error => error.code === 'REVIEW_CONFIG_MISMATCH');
  await assert.rejects(store.execution({ id: done.id, sessionId, workspaceId: done.workspaceId, revision: done.revision, config: done.config, until: 'export' }), error => error.code === 'REVIEW_CONFIG_MISMATCH');
  await assert.rejects(store.execution({ id: done.id, sessionId, workspaceId: 'other-workspace', revision: done.revision, config: done.config, until: done.until }), error => error.code === 'REVIEW_WORKSPACE_MISMATCH');
  await assert.rejects(store.execution({ id: done.id, sessionId, revision: done.revision, config: done.config, until: done.until }), /工作空间标识/);
  const frozen = await store.execution({ id: done.id, sessionId, workspaceId: done.workspaceId, revision: done.revision, config: done.config, until: done.until });
  assert.equal(frozen.until, 'discover'); assert.equal(frozen.snapshot.items.length, 14);
  assert.ok(Object.isFrozen(frozen.config.sources));
  assert.throws(() => { frozen.config.topic = 'changed'; }, TypeError);
  const pending = await store.act({ id: done.id, sessionId, revision: done.revision, action: 'edit', itemId: 'stage', value: { version: 2, until: 'fulltext' } });
  assert.equal(pending.ready, false); assert.equal(pending.until, 'fulltext');
  assert.equal(pending.items.find(item => item.id === 'processing').status, 'pending');
  await assert.rejects(store.execution({ id: pending.id, sessionId, workspaceId: pending.workspaceId, revision: pending.revision, config: pending.config, until: 'fulltext' }), /尚未全部确认/);
});

test('AI can add explanation and discussion atomically but cannot confirm or change values', async t => {
  const { store, sessionId, review } = await fixture(t);
  const explained = await store.applyAssist({ id: review.id, sessionId, revision: review.revision, groupId: 'scope',
    annotations: [{ itemId: 'topic', annotation: { explanation: '研究主题解释', basis: '用户原话', impact: '影响检索词', recommendation: '请确认' } },
      { itemId: 'years', annotation: { explanation: '从2000年开始' } }], question: '年份什么意思？', answer: '指发表年份。' });
  assert.equal(explained.revision, 2); assert.equal(explained.ready, false);
  assert.deepEqual(explained.config, review.config);
  assert.equal(explained.items.find(item => item.id === 'topic').discussion[0].answer, '指发表年份。');
  assert.ok(explained.items.every(item => item.status === 'pending'));
  for (const annotation of [{ status: 'confirmed' }, { value: { topic: 'AI改题' } }, { config: { query: 'bad' } }]) {
    await assert.rejects(store.applyAssist({ id: review.id, sessionId, revision: 2, annotations: [{ itemId: 'topic', annotation }] }), /不允许的字段/);
  }
  await assert.rejects(store.applyAssist({ id: review.id, sessionId, revision: 2, groupId: 'scope', annotations: [
    { itemId: 'topic', annotation: { explanation: '不能半写' } }, { itemId: 'source-queries', annotation: {} }
  ] }), /超出/);
  const unchanged = await store.get(review.id, sessionId);
  assert.equal(unchanged.revision, 2); assert.equal(unchanged.items.find(item => item.id === 'topic').annotation.explanation, '研究主题解释');
  const confirmed = await store.act({ id: review.id, sessionId, revision: 2, action: 'confirm', itemId: 'topic' });
  const answer = await store.act({ id: review.id, sessionId, revision: confirmed.revision, action: 'discussion', itemId: 'topic', question: '再说明', answer: '说明而已' });
  assert.equal(answer.items.find(item => item.id === 'topic').status, 'confirmed');
});

test('config sync invalidates only changed items; changed original evidence invalidates all confirmations and is recoverable', async t => {
  const { store, sessionId, review } = await fixture(t);
  const done = await confirmAll(store, sessionId, review);
  const synced = await store.act({ id: done.id, sessionId, revision: done.revision, action: 'sync', config: { ...done.config, query: 'cow OR cattle AND heat' }, until: 'discover', source: 'discussion-v1' });
  assert.equal(synced.progress.confirmed, 12);
  assert.equal(synced.items.find(item => item.id === 'query').status, 'pending');
  assert.equal(synced.items.find(item => item.id === 'source-queries').status, 'pending');
  assert.equal(synced.items.find(item => item.id === 'topic').status, 'confirmed');
  const evidenceChanged = await store.act({ id: synced.id, sessionId, revision: synced.revision, action: 'sync', config: synced.config, until: synced.until,
    source: 'discussion-v2', context: { messages: [{ role: 'user', text: '最新确认依据' }], approvedDoc: '' } });
  assert.equal(evidenceChanged.progress.confirmed, 0);
  assert.equal(evidenceChanged.sourceHistory.length, 1);
  assert.equal(evidenceChanged.sourceHistory[0].context.messages[0].text, review.context.messages[0].text);
  assert.ok(evidenceChanged.items.every(item => item.history.some(entry => entry.reason === 'source-changed')));
  const snapshot = await store.snapshot({ id: evidenceChanged.id, sessionId, revision: evidenceChanged.revision });
  assert.equal(snapshot.ready, false); assert.equal(snapshot.context.messages[0].text, '最新确认依据');
});

test('invalid IDs, unknown execution keys, omitted item keys and oversized evidence fail explicitly', async t => {
  const { store, sessionId, review } = await fixture(t);
  await assert.rejects(store.create({ sessionId, config: config({ hiddenExecutionOption: true }), until: 'discover' }), /未归属/);
  await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'edit', itemId: 'query', value: { query: 'good', sources: ['pubmed'] } }), /不允许/);
  await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'edit', itemId: 'query', value: {} }), /默认检索式/);
  await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: '../topic' }), /不存在/);
  await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: 'topic', status: 'confirmed' }), /不允许/);
  await assert.rejects(store.create({ sessionId, config: config(), until: 'discover', context: { messages: [], approvedDoc: 'x'.repeat(MAX_REVIEW_CONTEXT_BYTES + 1) } }), /超过/);
  assert.equal((await store.get(review.id, sessionId)).revision, 1);
});

test('an interrupted atomic replacement leaves the previous confirmation file intact', async t => {
  const { root, store, sessionId, review } = await fixture(t);
  const file = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  const before = await fs.readFile(file, 'utf8'), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === file) throw Object.assign(new Error('simulated write failure'), { code: 'EIO' }); return rename(from, to); };
  try {
    await assert.rejects(store.act({ id: review.id, sessionId, revision: 1, action: 'confirm', itemId: 'topic' }), /simulated write failure/);
  } finally { fs.rename = rename; }
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const persisted = await store.get(review.id, sessionId);
  assert.equal(persisted.revision, 1); assert.equal(persisted.items.find(item => item.id === 'topic').status, 'pending');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['review.json']);
});

test('changes invalidate dependent confirmations even when their normalized values stay equal', async t => {
  const { store, sessionId, review } = await fixture(t);
  let done = await confirmAll(store, sessionId, review);
  let edited = await store.act({ id: done.id, sessionId, revision: done.revision, action: 'edit', itemId: 'sources', value: { sources: ['google-scholar', 'pubmed'] } });
  assert.equal(edited.items.find(item => item.id === 'source-queries').status, 'pending');
  assert.deepEqual(edited.items.find(item => item.id === 'source-queries').value, done.items.find(item => item.id === 'source-queries').value);
  done = await confirmAll(store, sessionId, edited);
  const timeouts = done.items.find(item => item.id === 'timeouts').value;
  edited = await store.act({ id: done.id, sessionId, revision: done.revision, action: 'edit', itemId: 'search-mode', value: { limit: 10, searchMode: 'formal', perSourceLimit: 50, stopMode: 'count', batch: done.config.batch } });
  const dependent = edited.items.find(item => item.id === 'timeouts');
  assert.deepEqual(dependent.value, timeouts); assert.equal(dependent.status, 'pending');
  assert.equal(dependent.history.at(-1).reason, 'dependency-changed');
});

test('formal rule lists over the old 30-item limit survive review, confirmation and frozen execution without truncation', async t => {
  const { store, sessionId } = await fixture(t);
  const inclusion = Array.from({ length: 56 }, (_, index) => `第${index + 1}条：` + '完整保留原规则。'.repeat(90));
  const exclusion = Array.from({ length: 40 }, (_, index) => `排除条件${index + 1}`);
  let review = await store.create({ sessionId, workspaceId: 'formal-rules', config: config({ inclusion, exclusion }), until: 'discover' });
  assert.deepEqual(review.config.inclusion, inclusion);
  assert.deepEqual(review.config.exclusion, exclusion);
  review = await confirmAll(store, sessionId, review);
  const frozen = await store.execution({ id: review.id, sessionId, workspaceId: 'formal-rules', revision: review.revision, config: review.config, until: 'discover' });
  assert.deepEqual(frozen.config.inclusion, inclusion);
  assert.deepEqual(frozen.config.exclusion, exclusion);
  assert.throws(() => normalizeConfig(config({ inclusion: Array(201).fill('完整规则') })), /共有201项.*200项上限/);
  assert.throws(() => normalizeConfig(config({ inclusion: ['规'.repeat(2001)] })), /第1项共2001字.*2000字上限.*未自动截断/);
  assert.throws(() => normalizeConfig(config({ inclusion: '非列表的旧草稿' })), /必须是列表.*保留原内容/);
});

async function forkFixture(t, extra = {}) {
  const data = await fixture(t, extra), { root, store, sessionId } = data;
  let review = await store.act({ id: data.review.id, sessionId, revision: data.review.revision, action: 'annotation', itemId: 'query', annotation: { explanation: '原检索式说明' } });
  review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'discussion', itemId: 'query', question: '保留原词？', answer: '已说明原检索式。' });
  review = await confirmAll(store, sessionId, review);
  const execution = await store.execution({ id: review.id, sessionId, workspaceId: review.workspaceId, revision: review.revision, config: review.config, until: review.until });
  const jobId = crypto.randomUUID(), dir = path.join(root, '.workbench', 'literature', jobId);
  await fs.mkdir(dir, { recursive: true });
  const job = { id: jobId, status: 'needs_attention', config: review.config, until: review.until, files: ['run_config.json', 'rule-review-confirmed.json'] };
  for (const [name, value] of Object.entries({ 'job.json': job, 'run_config.json': review.config, 'rule-review-confirmed.json': execution.snapshot })) await fs.writeFile(path.join(dir, name), JSON.stringify(value));
  const request = { jobId, sessionId, workspaceId: review.workspaceId, requestId: crypto.randomUUID() };
  return { ...data, review, job, jobId, dir, request, execution };
}

test('fork uses the immutable job snapshot, preserves confirmations and evidence, and leaves both originals unchanged', async t => {
  const { store, sessionId, review, dir, request, execution, root } = await forkFixture(t);
  // The editable original review may have moved on since this job was frozen.
  const original = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'edit', itemId: 'query', value: { query: 'later editable draft' } });
  const originalFile = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  const before = await Promise.all(['job.json', 'run_config.json', 'rule-review-confirmed.json'].map(name => fs.readFile(path.join(dir, name), 'utf8')));
  const originalBytes = await fs.readFile(originalFile, 'utf8');
  const forked = await store.fork(request);
  assert.notEqual(forked.id, review.id); assert.equal(forked.revision, 1); assert.equal(forked.ready, true);
  assert.deepEqual(forked.progress, { confirmed: 14, total: 14 });
  assert.deepEqual(forked.items, execution.snapshot.items);
  assert.deepEqual(forked.config, execution.config); assert.notEqual(forked.config.query, original.config.query);
  assert.deepEqual(forked.source, review.source); assert.deepEqual(forked.context, review.context);
  assert.equal(forked.parentJobId, request.jobId); assert.equal(forked.parentReviewId, review.id); assert.equal(forked.parentRevision, review.revision);
  assert.equal(await fs.readFile(originalFile, 'utf8'), originalBytes);
  assert.deepEqual(await Promise.all(['job.json', 'run_config.json', 'rule-review-confirmed.json'].map(name => fs.readFile(path.join(dir, name), 'utf8'))), before);
  const frozen = await store.execution({ id: forked.id, sessionId, workspaceId: forked.workspaceId, revision: forked.revision, config: forked.config, until: forked.until });
  assert.equal(frozen.snapshot.parentJobId, request.jobId); assert.equal(frozen.snapshot.parentReviewId, review.id); assert.equal(frozen.snapshot.parentRevision, review.revision);
  assert.equal((await store.snapshot({ id: forked.id, sessionId })).parentJobId, request.jobId);
});

test('fork edits invalidate only changed/dependent items; changed original evidence invalidates every inherited confirmation', async t => {
  const { store, request, sessionId, review } = await forkFixture(t);
  const forked = await store.fork({ ...request, source: review.source, context: review.context });
  assert.equal(forked.ready, true);
  const edited = await store.act({ id: forked.id, sessionId, revision: forked.revision, action: 'edit', itemId: 'query', value: { query: 'cattle AND humidity' } });
  assert.equal(edited.progress.confirmed, 12); assert.equal(edited.items.find(item => item.id === 'query').status, 'pending');
  assert.equal(edited.items.find(item => item.id === 'source-queries').status, 'pending');
  assert.equal(edited.items.find(item => item.id === 'years').status, 'confirmed');
  const changedEvidence = await store.fork({ ...request, requestId: crypto.randomUUID(), context: { ...review.context, messages: [{ role: 'user', text: '新讨论依据' }] } });
  assert.equal(changedEvidence.ready, false); assert.equal(changedEvidence.revision, 2); assert.equal(changedEvidence.progress.confirmed, 0);
  assert.deepEqual(changedEvidence.sourceHistory[0].context, review.context);
  assert.ok(changedEvidence.items.every(item => item.history.at(-1).reason === 'source-changed'));
});

test('a cutoff-year revision only reopens years, blocks execution until re-confirmed, and never rewrites parent files', async t => {
  const { store, request, sessionId, dir, review } = await forkFixture(t, { publicationYearTo: 2027 });
  const names = ['job.json', 'run_config.json', 'rule-review-confirmed.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8')));
  const forked = await store.fork({ ...request, source: review.source, context: review.context });
  assert.equal(forked.progress.confirmed, 14);
  let updated = await store.act({ id: forked.id, sessionId, revision: forked.revision, action: 'edit', itemId: 'years', value: { publicationYearFrom: 2000, publicationYearTo: 2026 } });
  assert.equal(updated.progress.confirmed, 13); assert.deepEqual(updated.items.filter(item => item.status === 'pending').map(item => item.id), ['years']);
  const executionRequest = () => ({ id: updated.id, sessionId, workspaceId: updated.workspaceId, revision: updated.revision, config: updated.config, until: updated.until });
  await assert.rejects(store.execution(executionRequest()), error => error.code === 'REVIEW_NOT_READY');
  updated = await store.act({ id: updated.id, sessionId, revision: updated.revision, action: 'confirm', itemId: 'years' });
  assert.equal(updated.progress.confirmed, 14);
  const execution = await store.execution(executionRequest());
  assert.equal(execution.config.publicationYearFrom, 2000); assert.equal(execution.config.publicationYearTo, 2026);
  assert.equal(execution.snapshot.parentJobId, request.jobId); assert.equal(execution.snapshot.parentReviewId, review.id); assert.equal(execution.snapshot.parentRevision, review.revision);
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8'))), before);
});

test('fork request IDs are concurrent and restart-safe idempotent without merging different requests', async t => {
  const { root, store, request } = await forkFixture(t);
  const results = await Promise.all([store.fork(request), new LiteratureRuleReviewStore(root).fork(request)]);
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(await new LiteratureRuleReviewStore(root).fork(request), results[0]);
  await assert.rejects(store.fork({ ...request, source: 'different-basis' }), error => error.code === 'REVIEW_FORK_REQUEST_CONFLICT');
  assert.notEqual((await store.fork({ ...request, requestId: crypto.randomUUID() })).id, results[0].id);
});

test('fork rejects cross-session/workspace, client snapshots, unsafe IDs, running/deleted and nonordinary jobs', async t => {
  const { store, request, job, dir } = await forkFixture(t);
  await assert.rejects(store.fork({ ...request, sessionId: crypto.randomUUID() }), error => error.code === 'REVIEW_SESSION_MISMATCH');
  await assert.rejects(store.fork({ ...request, workspaceId: 'other-project' }), error => error.code === 'REVIEW_WORKSPACE_MISMATCH');
  await assert.rejects(store.fork({ ...request, snapshot: {} }), /不允许/);
  await assert.rejects(store.fork({ ...request, jobId: '../escape' }), /标识无效/);
  for (const [extra, expected] of [[{ status: 'running' }, 'REVIEW_PARENT_BUSY'], [{ deletedAt: '2026-10-27' }, 'REVIEW_PARENT_DELETED'],
    [{ segmentTask: {} }, 'REVIEW_PARENT_NOT_ORDINARY'], [{ materialReplenishment: {} }, 'REVIEW_PARENT_NOT_ORDINARY']]) {
    await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ ...job, ...extra }));
    await assert.rejects(store.fork(request), error => error.code === expected);
  }
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
  for (const live of [{ ...job, status: 'running' }, { ...job, child: {} }, { ...job, browserOpening: true }]) await assert.rejects(store.fork(request, live), error => error.code === 'REVIEW_PARENT_BUSY');
  for (const marker of ['segment-basis.json', 'materials-basis.json']) {
    await fs.writeFile(path.join(dir, marker), '{}');
    await assert.rejects(store.fork(request), error => error.code === 'REVIEW_PARENT_NOT_ORDINARY');
    await fs.unlink(path.join(dir, marker));
  }
});

test('fork refuses missing, tampered or incomplete frozen evidence and mismatched run configuration', async t => {
  const { store, request, dir, execution } = await forkFixture(t);
  const snapshotFile = path.join(dir, 'rule-review-confirmed.json');
  await fs.unlink(snapshotFile);
  await assert.rejects(store.fork(request), error => error.code === 'REVIEW_PARENT_SNAPSHOT_MISSING');
  const altered = [
    { ...execution.snapshot, fingerprint: '0'.repeat(64) },
    { ...execution.snapshot, items: execution.snapshot.items.slice(1) },
    { ...execution.snapshot, items: execution.snapshot.items.map((item, i) => i ? item : { ...item, status: 'pending' }) },
    { ...execution.snapshot, items: execution.snapshot.items.map((item, i) => i ? item : { ...item, value: { topic: 'injected' } }) }
  ];
  for (const value of altered) {
    await fs.writeFile(snapshotFile, JSON.stringify(value));
    await assert.rejects(store.fork(request), error => error.code === 'REVIEW_PARENT_SNAPSHOT_INVALID');
  }
  await fs.writeFile(snapshotFile, JSON.stringify(execution.snapshot));
  await fs.writeFile(path.join(dir, 'run_config.json'), JSON.stringify({ ...execution.config, query: 'different query' }));
  await assert.rejects(store.fork(request), error => error.code === 'REVIEW_PARENT_CONFIG_MISMATCH');
});

test('explicit history import binds a new target with server-proven source lineage while default and false remain strict', async t => {
  const { store, request, dir, root, review } = await forkFixture(t);
  const target = { ...request, sessionId: crypto.randomUUID(), workspaceId: 'new-history-workspace', source: review.source, context: review.context };
  const sourceFile = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  const names = ['job.json', 'run_config.json', 'rule-review-confirmed.json'];
  const before = await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8'))), originalReview = await fs.readFile(sourceFile, 'utf8');
  await assert.rejects(store.fork(target), error => error.code === 'REVIEW_SESSION_MISMATCH');
  await assert.rejects(store.fork({ ...target, fromHistory: false }), error => error.code === 'REVIEW_SESSION_MISMATCH');
  await assert.rejects(store.fork({ ...request, workspaceId: target.workspaceId, fromHistory: false }), error => error.code === 'REVIEW_WORKSPACE_MISMATCH');
  const imported = await store.fork({ ...target, fromHistory: true });
  assert.equal(imported.sessionId, target.sessionId); assert.equal(imported.workspaceId, target.workspaceId); assert.equal(imported.progress.confirmed, 14);
  assert.equal(imported.sourceSessionId, request.sessionId); assert.equal(imported.sourceWorkspaceId, request.workspaceId);
  assert.equal(imported.parentJobId, request.jobId); assert.equal(imported.parentReviewId, review.id); assert.equal(imported.parentRevision, review.revision);
  assert.equal(imported.history[0].action, 'import-history'); assert.equal(imported.sourceSnapshotFingerprint, imported.history[0].sourceSnapshotFingerprint);
  const frozen = await store.execution({ id: imported.id, sessionId: target.sessionId, workspaceId: target.workspaceId, revision: imported.revision, config: imported.config, until: imported.until });
  assert.equal(frozen.snapshot.sourceSessionId, request.sessionId); assert.equal(frozen.snapshot.sourceWorkspaceId, request.workspaceId);
  assert.equal(frozen.snapshot.sourceSnapshotFingerprint, imported.sourceSnapshotFingerprint);
  await assert.rejects(store.get(imported.id, request.sessionId), error => error.code === 'REVIEW_SESSION_MISMATCH');
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8'))), before);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), originalReview);
});

test('history imports preserve actual changed discussion as pending and are idempotent and isolated between targets', async t => {
  const { store, request, review, root } = await forkFixture(t);
  const target = { ...request, sessionId: crypto.randomUUID(), workspaceId: 'target-a', fromHistory: true,
    source: 'current-history-discussion', context: { messages: [{ role: 'user', text: '本工作区新补充的真实要求' }], approvedDoc: '' } };
  const first = await store.fork(target);
  assert.equal(first.ready, false); assert.equal(first.progress.confirmed, 0); assert.equal(first.revision, 2);
  assert.deepEqual(first.source, target.source); assert.deepEqual(first.context, target.context);
  assert.deepEqual(first.sourceHistory[0].context, review.context);
  assert.ok(first.items.every(item => item.history.at(-1).reason === 'source-changed'));
  assert.deepEqual(await new LiteratureRuleReviewStore(root).fork(target), first);
  const other = await store.fork({ ...target, sessionId: crypto.randomUUID(), workspaceId: 'target-b' });
  assert.notEqual(other.id, first.id); assert.equal(other.workspaceId, 'target-b');
  await assert.rejects(store.fork({ ...target, workspaceId: 'target-c' }), error => error.code === 'REVIEW_FORK_REQUEST_CONFLICT');
  await assert.rejects(store.fork({ ...target, sourceSessionId: request.sessionId }), /不允许/);
  await assert.rejects(store.fork({ ...target, fromHistory: 'true' }), /布尔值/);
  const omitted = { ...target }; delete omitted.context;
  await assert.rejects(store.fork(omitted), /必须提供当前讨论/);
});

test('history imports reject changed source config/hash and inconsistent original-review ownership', async t => {
  const { store, request, dir, root, review, execution } = await forkFixture(t);
  const target = { ...request, sessionId: crypto.randomUUID(), workspaceId: 'history-target', fromHistory: true, source: review.source, context: review.context };
  const frozenFile = path.join(dir, 'rule-review-confirmed.json'), configFile = path.join(dir, 'run_config.json');
  await fs.writeFile(frozenFile, JSON.stringify({ ...execution.snapshot, fingerprint: '0'.repeat(64) }));
  await assert.rejects(store.fork(target), error => error.code === 'REVIEW_PARENT_SNAPSHOT_INVALID');
  await fs.writeFile(frozenFile, JSON.stringify(execution.snapshot));
  await fs.writeFile(configFile, JSON.stringify({ ...execution.config, query: 'source altered' }));
  await assert.rejects(store.fork(target), error => error.code === 'REVIEW_PARENT_CONFIG_MISMATCH');
  await fs.writeFile(configFile, JSON.stringify(execution.config));
  const sourceFile = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  await fs.writeFile(sourceFile, JSON.stringify({ ...review, workspaceId: 'different-source-workspace' }));
  await assert.rejects(store.fork(target), error => error.code === 'REVIEW_PARENT_SNAPSHOT_INVALID');
  await fs.writeFile(sourceFile, JSON.stringify({ ...review, sessionId: crypto.randomUUID() }));
  await assert.rejects(store.fork(target), error => error.code === 'REVIEW_SESSION_MISMATCH');
});
