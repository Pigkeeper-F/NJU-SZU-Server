'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CodexBridge } = require('./codex-bridge');
const { saveLiteraturePrepareResult, readLiteraturePrepareResult, MAX_PREPARE_RESULT_BYTES } = require('./literature-prepare-results');
const PROJECT = path.resolve(__dirname, '..');
const ID = '11111111-1111-4111-8111-111111111111', SESSION = '22222222-2222-4222-8222-222222222222';
function snapshot(overrides = {}) { return { id: ID, sessionId: SESSION, status: 'completed', model: 'fixture-model', text: '完整的检索式和回复。'.repeat(3000), preview: '最后的预览', events: ['已返回文字'], error: null, files: [], ...overrides }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(PROJECT, '.test-prepare-results-'));
  t.after(() => { assert.equal(path.dirname(root), PROJECT); assert.ok(path.basename(root).startsWith('.test-prepare-results-')); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '.workbench', SESSION, 'input'), { recursive: true }); fs.mkdirSync(path.join(root, '.workbench', SESSION, 'output', ID), { recursive: true });
  return { root, file: path.join(root, '.workbench', 'literature-prepare-results', ID + '.json') };
}
function job(value = snapshot()) { return { id: value.id, sessionId: value.sessionId, status: 'running', kind: 'literature-prepare', model: value.model, messages: [{ text: value.text }], preview: value.preview, events: value.events, error: null }; }

test('terminal prepare text is saved completely, file results excluded, deduplicated and immutable', t => {
  const { root, file } = fixture(t), value = snapshot({ files: [{ group: 'output', name: 'not-a-prepare-result.csv', size: 123 }] });
  assert.equal(saveLiteraturePrepareResult(root, value).deduplicated, false);
  const restored = readLiteraturePrepareResult(root, ID, SESSION);
  assert.deepEqual(restored, { ...value, kind: 'literature-prepare', files: [] }); assert.ok(restored.text.length > 20000);
  const before = fs.readFileSync(file, 'utf8'); assert.equal(saveLiteraturePrepareResult(root, value).deduplicated, true);
  assert.throws(() => saveLiteraturePrepareResult(root, snapshot({ text: 'changed reply' })), error => error.code === 'PREPARE_RESULT_CONFLICT');
  assert.equal(fs.readFileSync(file, 'utf8'), before); restored.events.push('caller mutation'); assert.equal(readLiteraturePrepareResult(root, ID).events.length, 1);
});

test('bridge finish persists only marked prepare replies; a fresh bridge reads them without creating runnable jobs', async t => {
  const { root } = fixture(t), bridge = new CodexBridge(root), current = job();
  bridge.files = () => { throw new Error('Prepare must not claim file results'); }; bridge.jobs.set(ID, current); bridge.finish(current, 'completed');
  assert.equal(current.persistenceError, undefined);
  const fresh = new CodexBridge(root), restored = fresh.snapshot(ID);
  assert.equal(restored.status, 'completed'); assert.equal(restored.text, snapshot().text); assert.deepEqual(restored.files, []); assert.equal(fresh.jobs.size, 0); assert.equal(fresh.active(SESSION), undefined);
  await assert.rejects(fresh.cancel(ID), /运行记录不存在/); bridge.close(); fresh.close();
});

test('ordinary discussion terminal replies and running prepare replies are not archived', t => {
  const { root, file } = fixture(t), bridge = new CodexBridge(root), current = job(); delete current.kind;
  bridge.files = () => []; bridge.jobs.set(ID, current); bridge.finish(current, 'completed');
  assert.equal(fs.existsSync(file), false); assert.throws(() => new CodexBridge(root).snapshot(ID), /运行记录不存在/);
  assert.throws(() => saveLiteraturePrepareResult(root, snapshot({ status: 'running' })), /终态文字/);
  assert.throws(() => saveLiteraturePrepareResult(root, snapshot({ kind: 'ordinary-chat' })), /其他任务/); bridge.close();
});

test('run marker is restricted to text-only literature preparation and remains the optional tenth argument', async t => {
  const { root } = fixture(t), bridge = new CodexBridge(root);
  for (const args of [[true, 'literature-mining', null, null], [false, 'discussion', null, null], [false, 'literature-mining', {}, null], [false, 'literature-mining', null, {}]]) {
    await assert.rejects(bridge.run(SESSION, [], '', args[0], null, args[1], null, args[2], args[3], { kind: 'literature-prepare' }), /只读文字整理/);
  }
  await assert.rejects(bridge.run(SESSION, [], '', false, null, 'literature-mining', null, null, null, { kind: 'literature-prepare', execute: true }), /只读文字整理/);
  bridge.status = () => new Promise(() => {}); // Intentionally inert; no RPC or model call.
  const started = await bridge.run(SESSION, [{ role: 'user', content: 'fixture' }], 'fixture', false, null, 'literature-mining', null, null, null, { kind: 'literature-prepare' });
  assert.equal(started.kind, 'literature-prepare'); assert.equal(started.status, 'running'); assert.equal(readLiteraturePrepareResult(root, started.id), null);
  const current = bridge.jobs.get(started.id); bridge.finish(current, 'cancelled'); assert.equal(readLiteraturePrepareResult(root, started.id).status, 'cancelled'); bridge.close();
});

test('schema, identity, session, terminal status and symlink guards reject untrusted cached results', t => {
  const { root, file } = fixture(t); saveLiteraturePrepareResult(root, snapshot()); const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => readLiteraturePrepareResult(root, '../outside'), /标识无效/);
  assert.throws(() => readLiteraturePrepareResult(root, ID, '33333333-3333-4333-8333-333333333333'), error => error.code === 'PREPARE_RESULT_SCOPE_MISMATCH');
  for (const mutate of [record => record.kind = 'other-kind', record => record.schemaVersion = 2, record => record.snapshot.status = 'running', record => record.snapshot.id = SESSION, record => record.snapshot.files.push({ name: 'fake.csv' })]) {
    const record = JSON.parse(original); mutate(record); fs.writeFileSync(file, JSON.stringify(record)); assert.throws(() => readLiteraturePrepareResult(root, ID));
  }
  fs.writeFileSync(file, '{broken'); assert.throws(() => readLiteraturePrepareResult(root, ID), error => error.code === 'PREPARE_RESULT_CORRUPT'); fs.writeFileSync(file, original);
  const lstat = fs.lstatSync; fs.lstatSync = (...args) => { const stat = lstat(...args); return args[0] === file ? { ...stat, isFile: () => true, isSymbolicLink: () => true } : stat; };
  try { assert.throws(() => readLiteraturePrepareResult(root, ID), error => error.code === 'PREPARE_RESULT_UNSAFE_PATH'); } finally { fs.lstatSync = lstat; }
});

test('explicit capacity and publish failure never leave a partial terminal file or truncate text', t => {
  const { root, file } = fixture(t);
  assert.throws(() => saveLiteraturePrepareResult(root, snapshot({ text: 'x'.repeat(MAX_PREPARE_RESULT_BYTES) })), error => error.code === 'PREPARE_RESULT_CAPACITY' && error.statusCode === 413); assert.equal(fs.existsSync(file), false);
  const rename = fs.renameSync; fs.renameSync = () => { throw Object.assign(new Error('fixture publication failure'), { code: 'EIO' }); };
  try { assert.throws(() => saveLiteraturePrepareResult(root, snapshot()), /fixture publication failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
  const bridge = new CodexBridge(root), current = job(snapshot({ text: 'x'.repeat(MAX_PREPARE_RESULT_BYTES) })); bridge.jobs.set(ID, current); bridge.finish(current, 'completed');
  assert.equal(current.status, 'completed'); assert.match(bridge.snapshot(ID).persistenceError, /备份失败.*20MiB/); assert.equal(bridge.snapshot(ID).text.length, MAX_PREPARE_RESULT_BYTES); bridge.close();
});

test('required task and job directories must exist and must not be replaced with external pointers', t => {
  const { root, file } = fixture(t); const output = path.join(root, '.workbench', SESSION, 'output', ID); fs.rmdirSync(output);
  assert.throws(() => saveLiteraturePrepareResult(root, snapshot()), error => error.code === 'PREPARE_RESULT_SESSION_MISSING'); assert.equal(fs.existsSync(file), false);
});
