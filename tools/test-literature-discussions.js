'use strict';

// Production store/routes with isolated fixture files and inert services only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { LiteratureDiscussionStore, MAX_DISCUSSION_BYTES, MAX_MESSAGE_CHARS } = require('./literature-discussions');
const { backendFingerprint } = require('./literature-runtime');
const { catalog, buildConfig } = require('./literature-confirmed-plan');
const PROJECT = path.resolve(__dirname, '..');
const AT = '2026-10-27T09:00:00.000Z';
function snapshot(overrides = {}) {
  return { messages: [{ id: 'user-1', role: 'user', text: '需要完整保留的讨论。'.repeat(900), at: AT },
    { id: 'assistant-1', role: 'assistant', text: '已讨论的方案和候选建议必须分开。', at: AT },
    { id: 'system-1', role: 'system', text: '一次技术状态记录。', at: AT }],
  composer: '尚未发送的消息', docDraftText: '还在编辑的方案', docEditing: true,
  config: { topic: '草稿可以尚未完善', query: '', sources: [], templates: { literature: 'templates/local.xlsx', parameters: null } },
  until: 'discover', approvedDoc: { content: '原文档完整备份', status: 'approved', updatedAt: AT, approvedAt: AT },
  rules: { draft: '规则草稿', confirmed: '原来保存的规则文本', versions: [{ text: '原规则版本', at: AT }] }, ...overrides };
}
function request(overrides = {}) { return { projectId: 'project-a', moduleId: 'literature-mining', workspaceId: 'lit-a', name: '正式研究讨论', snapshot: snapshot(), ...overrides }; }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(PROJECT, '.test-literature-discussions-'));
  t.after(async () => { assert.equal(path.dirname(root), PROJECT); assert.ok(path.basename(root).startsWith('.test-literature-discussions-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store: new LiteratureDiscussionStore(root) };
}
const scope = raw => ({ projectId: raw.projectId, moduleId: raw.moduleId, workspaceId: raw.workspaceId });

test('complete Unicode messages, drafts, document/rules and incomplete config round-trip without trimming or execution', async t => {
  const { root, store } = await fixture(t), raw = request(), original = JSON.stringify(raw);
  const result = await store.save(raw);
  assert.equal(result.saved, true); assert.equal(result.deduplicated, false); assert.equal(result.discussion.revision, 1);
  assert.equal(result.discussion.messageCount, 3); assert.equal(result.discussion.userMessageCount, 1);
  assert.equal(result.discussion.assistantMessageCount, 1); assert.equal(result.discussion.systemMessageCount, 1);
  assert.equal(result.discussion.hasDraft, true); assert.equal(result.discussion.hasApprovedDoc, true); assert.equal(result.discussion.hasRules, true);
  const restored = await new LiteratureDiscussionStore(root).get(scope(raw));
  assert.deepEqual(restored.snapshot, raw.snapshot); assert.equal(JSON.stringify(raw), original);
  assert.ok(restored.snapshot.messages[0].text.length > 4000);
  raw.snapshot.messages[0].text = 'Only mutate caller copy';
  assert.notEqual((await store.get(scope(raw))).snapshot.messages[0].text, raw.snapshot.messages[0].text);
  const listed = await store.list({ projectId: raw.projectId, moduleId: raw.moduleId });
  assert.equal(listed.discussions[0].versions.length, 1); assert.ok(!JSON.stringify(listed).includes('需要完整保留'));
});

test('identical current content deduplicates; changed content and empty messages append recoverable versions', async t => {
  const { store } = await fixture(t), raw = request();
  await store.save(raw); const same = await store.save(JSON.parse(JSON.stringify(raw)));
  assert.equal(same.deduplicated, true); assert.equal(same.discussion.revision, 1);
  const empty = request({ snapshot: snapshot({ messages: [], composer: '', docDraftText: '', docEditing: false, config: null, approvedDoc: null, rules: null }) });
  const second = await store.save(empty); assert.equal(second.discussion.revision, 2); assert.equal(second.discussion.messageCount, 0);
  assert.equal(second.discussion.hasDraft, false);
  const listed = (await store.list({ projectId: raw.projectId, moduleId: raw.moduleId })).discussions[0];
  assert.deepEqual(listed.versions.map(item => item.messageCount), [3, 0]);
  assert.deepEqual((await store.get({ ...scope(raw), revision: 1 })).snapshot, raw.snapshot);
  assert.deepEqual((await store.get(scope(raw))).snapshot, empty.snapshot);
});

test('all confirmed source plans and followups round-trip their rules and Scholar batches without starting a job', async t => {
  const { root, store } = await fixture(t), data = catalog(PROJECT);
  for (const entry of [...data.entries, ...(data.followups || [])]) {
    const { config } = buildConfig(PROJECT, entry.id, new Date(AT));
    const raw = request({ workspaceId: entry.id, snapshot: snapshot({ config }) });
    const saved = await store.save(raw);
    assert.equal(saved.saved, true, entry.id);
    assert.deepEqual((await new LiteratureDiscussionStore(root).get(scope(raw))).snapshot.config, config, entry.id);
    assert.equal((await store.save(raw)).deduplicated, true, entry.id);
  }
  assert.deepEqual(await fs.readdir(path.join(root, '.workbench')), ['literature-discussions']);
});

test('new plan draft fields still reject nested credentials and file operations', async t => {
  const { store } = await fixture(t);
  const { config } = buildConfig(PROJECT, catalog(PROJECT).entries[0].id, new Date(AT));
  const good = request({ snapshot: snapshot({ config }) });
  await store.save(good);
  for (const key of ['screeningPolicy', 'researchPlan', 'scholarPlan']) {
    for (const forbidden of ['apiKey', 'cookie', 'authorization', 'filePath', 'outputDir']) {
      const bad = JSON.parse(JSON.stringify(good));
      bad.snapshot.config[key] = { ...(bad.snapshot.config[key] || {}), nested: { [forbidden]: 'must-not-save' } };
      await assert.rejects(store.save(bad), /凭据|文件操作/);
    }
  }
  assert.deepEqual((await store.get(scope(good))).snapshot, good.snapshot);
  assert.equal((await store.get(scope(good))).revision, 1);
});

test('parallel saves through different store objects append every distinct version without overwriting one another', async t => {
  const { root, store } = await fixture(t);
  const a = request(), b = request({ snapshot: snapshot({ composer: 'second draft' }) }), c = request({ snapshot: snapshot({ composer: 'third draft' }) });
  const results = await Promise.all([store.save(a), new LiteratureDiscussionStore(root).save(b), store.save(c)]);
  assert.deepEqual(results.map(result => result.discussion.revision).sort(), [1, 2, 3]);
  const values = await Promise.all([1, 2, 3].map(revision => store.get({ ...scope(a), revision })));
  assert.deepEqual(new Set(values.map(value => value.snapshot.composer)), new Set([a.snapshot.composer, b.snapshot.composer, c.snapshot.composer]));
  const before = await store.get({ ...scope(a), revision: 1 });
  await store.save(request({ snapshot: snapshot({ composer: 'a later version' }) }));
  assert.deepEqual(await store.get({ ...scope(a), revision: 1 }), before);
});

test('project/module/workspace scope is hashed and isolated with explicit missing-version responses', async t => {
  const { root, store } = await fixture(t), raw = request(); await store.save(raw);
  assert.deepEqual(await store.list({ projectId: 'other-project', moduleId: raw.moduleId }), { discussions: [] });
  assert.deepEqual(await store.list({ projectId: raw.projectId, moduleId: 'other-module' }), { discussions: [] });
  const other = await store.save(request({ workspaceId: 'lit-b' })); assert.equal(other.discussion.revision, 1);
  assert.equal((await store.list({ projectId: raw.projectId, moduleId: raw.moduleId })).discussions.length, 2);
  await assert.rejects(store.get({ ...scope(raw), workspaceId: 'missing' }), error => error.code === 'DISCUSSION_NOT_FOUND');
  await assert.rejects(store.get({ ...scope(raw), revision: 99 }), error => error.statusCode === 404);
  await assert.rejects(store.get({ ...scope(raw), revision: '../snapshot.json' }), error => error.statusCode === 404);
  await assert.rejects(store.save(request({ projectId: '../escape' })), /标识无效/);
  const projects = await fs.readdir(path.join(root, '.workbench', 'literature-discussions'));
  assert.ok(projects.every(name => /^[a-f0-9]{64}$/.test(name)));
});

test('strict payloads reject credentials, file selectors, duplicate IDs, unsupported roles and excess text without truncation', async t => {
  const { store } = await fixture(t); const good = request(); await store.save(good);
  for (const raw of [request({ apiKey: 'must-not-save' }), request({ filePath: 'C:/outside' }),
    request({ snapshot: { ...snapshot(), client: { credentials: 'not allowed' } } }),
    request({ snapshot: snapshot({ config: { ...good.snapshot.config, credentials: {} } }) }),
    request({ snapshot: snapshot({ config: { ...good.snapshot.config, extraction: { apiKey: 'must-not-save' } } }) }),
    request({ snapshot: snapshot({ rules: { draft: '', confirmed: '', versions: [{ text: 'rule', at: AT, password: 'no' }] } }) })]) await assert.rejects(store.save(raw), /凭据|不允许/);
  await assert.rejects(store.save(request({ snapshot: snapshot({ messages: [good.snapshot.messages[0], good.snapshot.messages[0]] }) })), /重复消息/);
  await assert.rejects(store.save(request({ snapshot: snapshot({ messages: [{ ...good.snapshot.messages[0], role: 'developer' }] }) })), /角色无效/);
  await assert.rejects(store.save(request({ snapshot: snapshot({ messages: [{ ...good.snapshot.messages[0], text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }] }) })), /20000.*未截断/);
  assert.equal((await store.list({ projectId: good.projectId, moduleId: good.moduleId })).discussions[0].revision, 1);
});

test('explicit total capacity failure preserves prior complete versions', async t => {
  const { store } = await fixture(t), raw = request(); await store.save(raw);
  const oversized = request({ snapshot: snapshot({ messages: Array.from({ length: 1100 }, (_, index) => ({ id: 'msg-' + index, role: 'user', text: 'x'.repeat(MAX_MESSAGE_CHARS), at: AT })) }) });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MAX_DISCUSSION_BYTES);
  await assert.rejects(store.save(oversized), error => error.code === 'DISCUSSION_CAPACITY' && error.statusCode === 413);
  assert.deepEqual((await store.get(scope(raw))).snapshot, raw.snapshot);
});

test('failed atomic commit leaves no published partial version and does not replace old records', async t => {
  const { store } = await fixture(t), raw = request(); await store.save(raw);
  const rename = fs.rename; fs.rename = async () => { throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' }); };
  try { await assert.rejects(store.save(request({ snapshot: snapshot({ composer: 'not committed' }) })), /fixture rename failure/); }
  finally { fs.rename = rename; }
  const listed = (await store.list({ projectId: raw.projectId, moduleId: raw.moduleId })).discussions[0];
  assert.equal(listed.revision, 1); assert.equal(listed.versions.length, 1);
  assert.deepEqual((await store.get(scope(raw))).snapshot, raw.snapshot);
  const dir = await store._directory(scope(raw)); assert.deepEqual(await fs.readdir(dir), ['000000000001']);
});

test('corrupt or symlinked records cannot be read, deduplicated as saved, or silently overwritten', async t => {
  const { store } = await fixture(t), raw = request(); await store.save(raw);
  const dir = await store._directory(scope(raw)), file = path.join(dir, '000000000001', 'snapshot.json');
  await fs.writeFile(file, '{"messages":[]}');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.get(scope(raw)), /校验不一致|讨论快照|阶段无效/);
  await assert.rejects(store.save(raw), /校验不一致|讨论快照|阶段无效/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const lstat = fs.lstat;
  fs.lstat = async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === file) return { ...stat, isFile: () => true, isSymbolicLink: () => true };
    return stat;
  };
  try { await assert.rejects(store.get(scope(raw)), error => error.code === 'DISCUSSION_UNSAFE_PATH'); }
  finally { fs.lstat = lstat; }
});

test('production backup routes work while AI is busy and never access a model, task runner or confirmation store', async t => {
  const { store } = await fixture(t), source = syncFs.readFileSync(path.join(PROJECT, 'server.js'), 'utf8');
  const start = source.indexOf('async function handleLiterature('), end = source.indexOf('\nfunction normalizeMessages(', start);
  let bodyLimit;
  // VM request literals have a different Object.prototype; production routes and
  // the store share a realm. Clone at this test boundary without loosening validation.
  const native = value => JSON.parse(JSON.stringify(value));
  const service = { save: value => store.save(native(value)), list: value => store.list(native(value)), get: value => store.get(native(value)) };
  const context = vm.createContext({ JSON, MAX_DISCUSSION_BYTES, literatureDiscussions: service,
    literatureAuxiliary: { assertIdle() { throw new Error('Backup must not be blocked by AI activity'); } },
    readBody: async (req, limit) => { bodyLimit = limit; if (Buffer.byteLength(req.body) > limit) throw new Error('请求内容过大'); return req.body; },
    sendJson(res, status, data) { Object.assign(res, { status, data }); } });
  vm.runInContext(source.slice(start, end), context);
  const call = async (method, route, raw) => { const res = {}; await context.handleLiterature({ method, body: JSON.stringify(raw) }, res, new URL('http://fixture/api/literature/' + route)); return res; };
  const raw = request(), saved = await call('POST', 'discussions', raw);
  assert.equal(saved.status, 201); assert.equal(bodyLimit, MAX_DISCUSSION_BYTES);
  const query = new URLSearchParams(scope(raw));
  const list = await call('GET', 'discussions?projectId=project-a&moduleId=literature-mining');
  assert.equal(list.status, 200); assert.equal(list.data.discussions[0].versions.length, 1);
  const detail = await call('GET', 'discussion?' + query);
  assert.equal(detail.status, 200); assert.deepEqual(detail.data.snapshot, raw.snapshot);
  assert.equal((await call('POST', 'discussions', { ...raw, credentials: {} })).status, 400);
});

test('discussion backend code participates in runtime fingerprint while saved conversations do not', async t => {
  const { root, store } = await fixture(t), before = backendFingerprint(root);
  await store.save(request()); assert.equal(backendFingerprint(root), before);
  await fs.mkdir(path.join(root, 'tools')); await fs.writeFile(path.join(root, 'tools', 'literature-discussions.js'), '// fixture backend');
  assert.notEqual(backendFingerprint(root), before);
});
