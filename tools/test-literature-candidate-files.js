'use strict';

// Isolated files and inert production handlers only. No browser, model, socket,
// real research task, or backfill write to a historical job is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { LiteratureConnector } = require('./literature-connector');

function fixture(t, files = ['run_config.json', 'rule-review-confirmed.json']) {
  const project = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(project, '.test-literature-candidate-files-'));
  t.after(() => {
    assert.equal(path.dirname(root), project); assert.ok(path.basename(root).startsWith('.test-literature-candidate-files-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = randomUUID(), dir = path.join(root, '.workbench', 'literature', id);
  fs.mkdirSync(dir, { recursive: true });
  const config = { topic: 'fixture', query: 'fixture', sources: ['scopus'], limit: 10 };
  fs.writeFileSync(path.join(dir, 'run_config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'rule-review-confirmed.json'), '{"fixture":"immutable confirmation"}');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, status: 'cancelled', stage: 'cancelled', config, count: 2,
    files, events: [], counters: {}, stages: { discover: 'pending' }, until: 'discover', resumeStage: null }));
  const service = new LiteratureConnector(root);
  service.run = () => { throw new Error('Viewing candidates cannot run a task'); };
  return { root, id, dir, config, service };
}
function writeCandidates(dir) {
  fs.writeFileSync(path.join(dir, 'candidates.json'), '{"records":[{"candidate_id":"SCOPUS-001"}]}');
  fs.writeFileSync(path.join(dir, 'candidates.csv'), 'candidate_id\nSCOPUS-001\n');
}
function files(service, id) {
  return { snapshot: service.snapshot(id).files, listed: service.list(50).find(job => job.id === id).files };
}
function preserve(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter(name => fs.lstatSync(path.join(dir, name)).isFile()).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

test('cancelled legacy snapshots/list/download recover existing candidates without rewriting any historical file', t => {
  const { service, id, dir } = fixture(t); writeCandidates(dir);
  fs.writeFileSync(path.join(dir, 'unregistered.json'), '{}');
  const before = preserve(dir);
  for (const names of Object.values(files(service, id))) {
    assert.ok(names.includes('candidates.json')); assert.ok(names.includes('candidates.csv'));
    assert.ok(!names.includes('unregistered.json'));
  }
  for (const name of ['candidates.json', 'candidates.csv']) assert.equal(service.download(id, name), path.join(dir, name));
  assert.equal(service.jobs.size, 0, 'Read-only recovery must not load or bind a mutable live job');
  assert.deepEqual(preserve(dir), before);
  const live = service.loadPersisted(id), priorFiles = [...live.files];
  assert.ok(service.public(live).files.includes('candidates.csv')); assert.deepEqual(live.files, priorFiles, 'Public projection cannot mutate the loaded job');
  assert.deepEqual(preserve(dir), before);
});

test('missing candidates and directories are neither advertised nor downloadable, even if previously registered', t => {
  const { service, id, dir } = fixture(t, ['run_config.json', 'candidates.json', 'candidates.csv']);
  fs.mkdirSync(path.join(dir, 'candidates.json'));
  const before = fs.readFileSync(path.join(dir, 'job.json'), 'utf8');
  for (const names of Object.values(files(service, id))) {
    assert.ok(!names.includes('candidates.json')); assert.ok(!names.includes('candidates.csv'));
  }
  for (const name of ['candidates.json', 'candidates.csv', '../candidates.csv', 'nested/candidates.csv']) assert.throws(() => service.download(id, name), /不存在|安全/);
  assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), before);
});

test('candidate files below a symlink/junction job directory remain inaccessible', t => {
  const { service, root, id, dir } = fixture(t), target = path.join(root, 'outside-job');
  fs.renameSync(dir, target); writeCandidates(target);
  fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir');
  const before = preserve(target);
  for (const names of Object.values(files(service, id))) {
    assert.ok(!names.includes('candidates.json')); assert.ok(!names.includes('candidates.csv'));
  }
  for (const name of ['candidates.json', 'candidates.csv']) assert.throws(() => service.download(id, name), /不存在|安全/);
  assert.deepEqual(preserve(target), before);
});

test('a candidate filename that is a symlink/junction cannot be recovered', t => {
  const { service, root, id, dir } = fixture(t), target = path.join(root, 'outside-candidate');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'data.csv'), 'must remain outside\n');
  // Windows junctions require no symlink privilege; safeFile rejects both forms.
  fs.symlinkSync(target, path.join(dir, 'candidates.csv'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const names of Object.values(files(service, id))) assert.ok(!names.includes('candidates.csv'));
  assert.throws(() => service.download(id, 'candidates.csv'), /不存在|安全/);
});

test('new discovery page progress registers candidate files before cancellation or final result', t => {
  const { service, id, dir } = fixture(t), live = service.loadPersisted(id);
  live.status = 'running'; live.runId = 1; writeCandidates(dir);
  service.onStageEvent(live, 1, 'discover', { type: 'stage', stage: 'search', count: 2, files: ['candidates.json', 'candidates.csv'], message: 'fixture page saved' });
  assert.ok(live.files.includes('candidates.json')); assert.ok(live.files.includes('candidates.csv'));
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  assert.ok(persisted.files.includes('candidates.csv')); assert.equal(persisted.status, 'running');
  const cancelled = service.cancel(id); assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.files.includes('candidates.csv'));
});

test('production history, job and download routes agree about recovered candidates', async t => {
  const { service, id, dir } = fixture(t); writeCandidates(dir); const before = preserve(dir);
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function handleLiterature('), end = source.indexOf('\nfunction normalizeMessages(', start);
  const context = vm.createContext({ scholar: service, fs, path, sendJson(res, status, data) { Object.assign(res, { status, data }); } });
  vm.runInContext(source.slice(start, end), context);
  const get = async url => { const res = {}; await context.handleLiterature({ method: 'GET' }, res, new URL('http://fixture/api/literature/' + url)); return res; };
  const history = await get('jobs?limit=20'), job = await get('job?id=' + id);
  assert.equal(history.status, 200); assert.equal(job.status, 200);
  assert.deepEqual(history.data.jobs[0].files, job.data.files);
  assert.ok(job.data.files.includes('candidates.json')); assert.ok(job.data.files.includes('candidates.csv'));
  // Exercise the connector used by the download route without opening a stream/socket.
  for (const name of job.data.files.filter(name => name.startsWith('candidates.'))) assert.equal(fs.statSync(service.download(id, name)).isFile(), true);
  assert.deepEqual(preserve(dir), before);
});
