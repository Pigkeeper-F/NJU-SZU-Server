#!/usr/bin/env node
'use strict';

// Exercise the production route handler with in-memory services. No server,
// browser, model, download or user job is operated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LiteratureAuxiliary } = require('./literature-auxiliary');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const from = source.indexOf('async function handleLiterature(');
const to = source.indexOf('\nfunction normalizeMessages(', from);
assert.ok(from >= 0 && to > from);

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function main() {
  const calls = [], gate = deferred();
  const scholar = {
    async segmentPreview(id) { calls.push(['preview', id]); return gate.promise; },
    async createSegmentTask(data) { calls.push(['create', data]); return { id: 'new-fixture', status: 'needs_attention' }; },
    advance(id, options) { calls.push(['advance', id, options]); return { id, status: 'fixture-only' }; }
  };
  const auxiliary = new LiteratureAuxiliary('unused-in-memory-root', scholar);
  const context = vm.createContext({ scholar, literatureAuxiliary: auxiliary,
    readBody: async req => req.body || '{}',
    sendJson(res, code, body) { res.code = code; res.body = JSON.parse(JSON.stringify(body)); }, console });
  vm.runInContext(source.slice(from, to), context, { filename: 'server-literature-handler.js' });
  const request = async (method, route, body) => {
    const res = {};
    await context.handleLiterature({ method, body: JSON.stringify(body || {}) }, res, new URL('http://fixture' + route));
    return res;
  };

  const preview = request('GET', '/api/literature/segment-preview?id=source-fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(auxiliary.busy, true, 'Source is protected during the awaited local input inspection');
  const blocked = await request('POST', '/api/literature/advance', { id: 'source-fixture', until: 'extract' });
  assert.equal(blocked.code, 409);
  assert.equal(calls.filter(call => call[0] === 'advance').length, 0);
  gate.resolve({ papers: [], sourceJobId: 'source-fixture' });
  assert.equal((await preview).code, 200);
  assert.equal(auxiliary.busy, false);

  const createGate = deferred();
  scholar.createSegmentTask = async data => {
    calls.push(['create', data]);
    assert.equal(auxiliary.busy, true);
    return createGate.promise;
  };
  const data = { sourceJobId: 'source-fixture', paperIds: ['P1'], fromStage: 'extract', until: 'export', requestId: 'request-fixture' };
  const creation = request('POST', '/api/literature/segment-task', data);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(auxiliary.busy, true);
  createGate.resolve({ id: 'new-fixture', status: 'needs_attention', resumeStage: 'extract' });
  const created = await creation;
  assert.equal(created.code, 201);
  assert.equal(created.body.status, 'needs_attention');
  assert.equal(auxiliary.busy, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call[0] === 'create')[1])), data);
  assert.equal(calls.filter(call => call[0] === 'advance').length, 0, 'Creation never starts execution');

  for (const body of [[], { ...data, runNow: true }, { ...data, fieldDefinitions: [] }]) {
    assert.equal((await request('POST', '/api/literature/segment-task', body)).code, 400);
  }
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  scholar.createSegmentTask = async () => { throw Object.assign(new Error('fixture rejection'), { status: 409 }); };
  assert.equal((await request('POST', '/api/literature/segment-task', data)).code, 409);
  assert.equal(auxiliary.busy, false, 'Failed creation releases the shared lock');

  const advanced = await request('POST', '/api/literature/advance', { id: 'new-fixture', until: 'export', confirmSegment: true });
  assert.equal(advanced.code, 200);
  const advance = calls.find(call => call[0] === 'advance');
  assert.equal(advance[2].confirmSegment, true);
  assert.equal(advance[2].until, 'export');
  console.log('PASS literature segment routes: paused creation, awaited source lock, explicit range confirmation, strict request body');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
