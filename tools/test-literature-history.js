'use strict';

// Isolated task fixtures and an ephemeral HTTP listener. Never reads or changes
// the user's .workbench directory, database pages, or running server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector } = require('./literature-connector');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-history-'));
const config = { topic: 'fixture', query: 'fixture', sources: ['cnki'], limit: 10,
  searchMode: 'formal', stopMode: 'end', perSourceLimit: null };

function fixture(status = 'needs_attention', customConfig = config) {
  const id = randomUUID(), dir = path.join(root, '.workbench', 'literature', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run_config.json'), JSON.stringify(customConfig));
  fs.writeFileSync(path.join(dir, 'discovery-state.json'), JSON.stringify({ pending_source: 'cnki', sources: { cnki: { next_page: 3, status: 'attention' } } }));
  fs.writeFileSync(path.join(dir, 'candidates.csv'), 'title\npreserved\n');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, config: customConfig, status, stage: status === 'completed' ? 'completed' : 'verification',
    resumeStage: 'discover', until: 'discover', count: 30, files: ['run_config.json', 'candidates.csv'], events: [], error: null,
    attention: { source: 'cnki', reason: 'verification' }, stages: { discover: 'pending' }, extraFixtureMetadata: 'preserve' }));
  return { id, dir };
}
function bytes(dir) {
  return Object.fromEntries(['run_config.json', 'discovery-state.json', 'candidates.csv'].map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}
function connector() {
  return new LiteratureConnector(root, { prepare: async () => { throw new Error('No real execution allowed'); },
    openSource: async (_job, _python, source) => ({ opened: true, source }) });
}
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function serverFunction(name) {
  const asyncStart = serverSource.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : serverSource.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Missing server handler ' + name);
  return serverSource.slice(start, serverSource.indexOf('\n}', start) + 2);
}

async function main() {
  let service = connector();
  for (const status of ['completed', 'needs_attention', 'failed']) {
    const task = fixture(status), preserved = bytes(task.dir);
    assert.equal(service.snapshot(task.id).deletedAt, null);
    const deleted = service.deleteJob(task.id);
    assert.ok(deleted.deletedAt); assert.equal(deleted.status, status); assert.equal(deleted.count, 30);
    assert.equal(service.deleteJob(task.id).deletedAt, deleted.deletedAt, 'Repeated delete must be idempotent');
    assert.ok(!service.list(50).some(item => item.id === task.id));
    assert.ok(service.list(50, { includeDeleted: true }).some(item => item.id === task.id));
    assert.deepEqual(bytes(task.dir), preserved, 'Delete must not rewrite files, config, or page checkpoint');
    assert.equal(JSON.parse(fs.readFileSync(path.join(task.dir, 'job.json'))).extraFixtureMetadata, 'preserve');
    assert.throws(() => service.advance(task.id), /先恢复/);
    assert.throws(() => service.cancel(task.id), /先恢复/);
    await assert.rejects(service.openLogin(task.id), /先恢复/);
    assert.equal(fs.readFileSync(service.download(task.id, 'candidates.csv'), 'utf8'), preserved['candidates.csv'], 'Deleted results remain readable');
    service = connector();
    assert.equal(service.snapshot(task.id).deletedAt, deleted.deletedAt, 'Deletion survives a backend restart');
    const restored = service.restoreJob(task.id);
    assert.equal(restored.deletedAt, null); assert.equal(restored.status, status); assert.equal(restored.id, task.id);
    assert.equal(service.restoreJob(task.id).deletedAt, null);
    assert.deepEqual(bytes(task.dir), preserved);
    assert.ok(service.list(50).some(item => item.id === task.id));
  }
  for (const invalid of ['../job', 'bad', '']) assert.throws(() => service.deleteJob(invalid), /无效检索任务/);
  assert.throws(() => service.restoreJob(randomUUID()), /不存在/);
  const busy = fixture(); const live = service.loadPersisted(busy.id);
  for (const flag of ['status', 'child', 'browserOpening']) {
    if (flag === 'status') live.status = 'running'; else live[flag] = true;
    assert.throws(() => service.deleteJob(busy.id), /先停止/);
    if (flag === 'status') live.status = 'needs_attention'; else live[flag] = null;
  }
  const stale = fixture('running'); const staleBytes = bytes(stale.dir);
  const staleDeleted = connector().deleteJob(stale.id);
  assert.equal(staleDeleted.stage, 'interrupted'); assert.equal(staleDeleted.status, 'needs_attention');
  assert.ok(staleDeleted.deletedAt, 'A stale persisted running task is recoverable before hiding');
  const staleRestored = connector().restoreJob(stale.id);
  assert.equal(staleRestored.stage, 'interrupted'); assert.equal(staleRestored.deletedAt, null);
  assert.deepEqual(bytes(stale.dir), staleBytes);
  const staleLegacy = fixture('running', { topic: 'legacy', query: 'q', sources: ['cnki'], limit: 2 });
  assert.equal(connector().deleteJob(staleLegacy.id).status, 'failed', 'Legacy interrupted tasks can also be deleted without running them');

  // Execute the real literature HTTP handler and guards against the temporary
  // connector. The wrapper keeps the same POST X-Workbench check as server.js.
  const allowedHosts = new Set(), allowedOrigins = new Set();
  const context = vm.createContext({ scholar: service, fs, path, Buffer, URL, MAX_BODY_BYTES: 2 * 1024 * 1024,
    literatureAuxiliary: { active: false, busy: false, assertIdle() {}, acquire() { return () => {}; },
      job() { throw new Error('fixture does not exercise auxiliary jobs'); } },
    ALLOWED_HOSTS: allowedHosts, ALLOWED_ORIGINS: allowedOrigins, RATE_LIMIT: { max: 30, windowMs: 60000 }, rateCount: 0, rateWindowStart: 0 });
  vm.runInContext(['sendJson', 'readBody', 'checkRequestGuards', 'handleLiterature'].map(serverFunction).join('\n')
    + '\nglobalThis.handlers = { sendJson, checkRequestGuards, handleLiterature };', context);
  const handler = context.handlers;
  const server = http.createServer((req, res) => {
    if (!handler.checkRequestGuards(req, res)) return;
    if (req.method === 'POST' && req.headers['x-workbench'] !== '1') return handler.sendJson(res, 403, { error: '请从工作台发起请求' });
    handler.handleLiterature(req, res, new URL(req.url, 'http://localhost')).catch(error => handler.sendJson(res, 500, { error: error.message }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  allowedHosts.add('127.0.0.1:' + port); allowedOrigins.add(base);
  const post = (route, body, headers = { 'X-Workbench': '1' }) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const httpTask = fixture();
  try {
    for (const route of ['/api/literature/delete', '/api/literature/restore']) {
      assert.equal((await post(route, { id: httpTask.id }, {})).status, 403);
      assert.equal((await post(route, { id: httpTask.id }, { 'X-Workbench': '1', Origin: 'https://untrusted.test' })).status, 403);
      assert.equal((await post(route, { id: '../bad' })).status, 400);
      assert.equal((await post(route, { id: httpTask.id, path: '/arbitrary' })).status, 400);
    }
    assert.equal((await post('/api/literature/delete', { id: httpTask.id })).status, 200);
    let result = await (await fetch(base + '/api/literature/jobs?limit=50')).json();
    assert.ok(!result.jobs.some(item => item.id === httpTask.id));
    result = await (await fetch(base + '/api/literature/jobs?limit=50&includeDeleted=1')).json();
    assert.ok(result.jobs.some(item => item.id === httpTask.id && item.deletedAt));
    assert.equal((await post('/api/literature/advance', { id: httpTask.id })).status, 400);
    assert.equal((await post('/api/literature/browser', { id: httpTask.id })).status, 400);
    assert.equal((await post('/api/literature/cancel?id=' + httpTask.id, {})).status, 400);
    assert.equal((await fetch(base + '/api/literature/download?id=' + httpTask.id + '&name=candidates.csv')).status, 200);
    assert.equal((await post('/api/literature/restore', { id: httpTask.id })).status, 200);
    result = await (await fetch(base + '/api/literature/jobs?limit=50')).json();
    assert.ok(result.jobs.some(item => item.id === httpTask.id && item.deletedAt === null));
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('LITERATURE_HISTORY_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanxu-history-')) throw new Error('Unexpected fixture path');
  fs.rmSync(target, { recursive: true, force: true });
});
