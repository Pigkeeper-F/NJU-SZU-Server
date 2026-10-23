'use strict';
// Actual server handlers and connector, with isolated files and model/process
// doubles. Never reads or changes a real task or calls an external service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { LiteratureConnector } = require('./literature-connector');
const { LiteratureAuxiliary } = require('./literature-auxiliary');
const { createLiteratureRuntime } = require('./literature-runtime');
const ROOT = path.resolve(__dirname, '..');
const ID = '11111111-1111-4111-8111-111111111111';
const MISSING = '22222222-2222-4222-8222-222222222222';
const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
function sourceFunction(name) {
  const a = source.indexOf('async function ' + name + '('), b = source.indexOf('\n}', a);
  return source.slice(a, b + 2);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-aux-test-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools/literature-sources.js'), path.join(root, 'tools/literature-sources.js'));
    fs.copyFileSync(path.join(ROOT, 'tools/literature-sources.json'), path.join(root, 'tools/literature-sources.json'));
    const scholar = new LiteratureConnector(root), auxiliary = new LiteratureAuxiliary(root, scholar);
    const dir = path.join(root, '.workbench/literature', ID);
    fs.mkdirSync(dir, { recursive: true });
    const job = { id: ID, dir, status: 'completed', stage: 'completed', resumeStage: 'dedupe', until: 'discover',
      config: { topic: 'fixture', query: 'fixture', sources: ['pubmed'], limit: 10 },
      stages: { discover: 'done', dedupe: 'pending', fulltext: 'pending', extract: 'pending', validate: 'pending', export: 'pending' },
      counters: { candidates: 1 }, count: 1, files: ['candidates.json'], events: [], deferredSources: [] };
    const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
    write('run_config.json', job.config); write('candidates.json', { records: [{ candidate_id: 'PMID-001', title: 'fixture' }] });
    scholar.jobs.set(ID, job); scholar.persist(job);
    const runtime = createLiteratureRuntime({ root, port: 8123, isBusy: () => auxiliary.busy });
    let modelCalls = 0, processCalls = 0, gate = null, bodyGate = null, failModel = false;
    const generate = async () => {
      modelCalls++; assert.equal(runtime.snapshot().busy, true);
      if (gate) await gate;
      if (failModel) throw new Error('fixture model failure');
      fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'research/notes.json'), '{"notes":[]}');
      return { ok: true, files: ['research/notes.json'], notes: [], synthesis: {}, gaps: [] };
    };
    const context = vm.createContext({ ROOT: root, fs, path, os, process, console,
      scholar, literatureAuxiliary: auxiliary, literatureRuntime: runtime,
      readBody: async req => { if (bodyGate) await bodyGate; return JSON.stringify(req.data); },
      sendJson: (res, status, data) => Object.assign(res, { status, data }),
      resolveModelConfig: () => ({ apiKey: 'fixture' }), normalizeCredential: () => null,
      callModelWithRetry: () => { throw new Error('Unexpected live model'); },
      configInfo: () => ({}), configSource: () => 'fixture', researchErrorStatus: () => 502,
      require: name => name === './tools/literature-research' ? { runResearchStage: generate }
        : name === './tools/research-question' ? { planQueries: generate, buildCandidates: generate, buildSpecification: generate,
          loadResearchOutputs: () => ({ gaps: [], notes: [], topic: 'fixture' }) }
          : name === './tools/literature-sources' ? require('./literature-sources') : require(name),
      spawn: () => {
        processCalls++; assert.equal(runtime.snapshot().busy, true);
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ status: 'ok', added: 1, total: 2, files: ['candidates.json', 'candidates.csv'] }));
          fs.writeFileSync(path.join(dir, 'candidates.csv'), 'title\nfixture\nimported'); child.emit('close', 0); });
        return child;
      }
    });
    vm.runInContext(sourceFunction('handleLiterature') + '\n' + sourceFunction('handleResearch') + '\nglobalThis.handlers={handleLiterature,handleResearch};', context);
    const call = async (route, data = {}, method = 'POST') => {
      const res = {}; const fn = route.startsWith('/api/research/') ? context.handlers.handleResearch : context.handlers.handleLiterature;
      await fn({ method, data }, res, new URL('http://fixture' + route)); return res;
    };
    for (const id of ['../bad', MISSING]) {
      const before = modelCalls; const r = await call('/api/literature/research', { jobId: id });
      assert.ok([400, 404].includes(r.status)); assert.equal(modelCalls, before); assert.equal(auxiliary.busy, false);
    }
    for (const state of [{ deletedAt: 'fixture' }, { status: 'running' }, { child: {} }]) {
      const old = { ...job }; Object.assign(job, state); const r = await call('/api/literature/research', { jobId: ID });
      assert.equal(r.status, 409); Object.assign(job, old); delete job.deletedAt; delete job.child;
    }
    let releaseGate; gate = new Promise(resolve => { releaseGate = resolve; });
    const before = { status: job.status, stage: job.stage, until: job.until, resumeStage: job.resumeStage };
    const pending = call('/api/literature/research', { jobId: ID }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.snapshot().busy, true);
    for (const route of ['advance', 'delete', 'search']) assert.equal((await call('/api/literature/' + route, { id: ID })).status, 409);
    assert.equal((await call('/api/literature/runtime', {}, 'GET')).data.busy, true);
    releaseGate(); assert.equal((await pending).status, 200); gate = null;
    assert.deepEqual({ status: job.status, stage: job.stage, until: job.until, resumeStage: job.resumeStage }, before);
    assert.ok(job.files.includes('research/notes.json')); assert.equal(auxiliary.busy, false);
    failModel = true; assert.equal((await call('/api/literature/research-plan', { idea: 'fixture' })).status, 502);
    assert.equal(auxiliary.busy, false); failModel = false;
    assert.equal((await call('/api/research/questions', { upstreamJobIds: ['../bad'] })).status, 400);
    assert.equal(auxiliary.busy, false);
    const candidateBefore = fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8');
    assert.equal((await call('/api/literature/import', { jobId: ID, content: 'fixture' })).status, 409, 'Research artifacts freeze candidate import');
    assert.equal(processCalls, 0); assert.equal(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8'), candidateBefore);
    // Remove only the known disposable fixture research file before testing an import-ready search job.
    fs.unlinkSync(path.join(dir, 'research/notes.json')); fs.rmdirSync(path.join(dir, 'research'));
    job.files = ['candidates.json']; scholar.persist(job);
    assert.equal((await call('/api/literature/import', { jobId: ID, content: 'fixture' })).status, 200);
    assert.equal(job.count, 2); assert.equal(job.counters.candidates, 2); assert.ok(job.files.includes('candidates.csv'));
    assert.equal(auxiliary.busy, false);
    write('confirmations.json', { records: [] });
    assert.equal((await call('/api/literature/import', { jobId: ID, content: 'fixture' })).status, 409);
    assert.equal(processCalls, 1);
    let releaseBody; bodyGate = new Promise(resolve => { releaseBody = resolve; });
    const waitingBody = call('/api/literature/search', {}); await new Promise(resolve => setImmediate(resolve));
    const unlock = auxiliary.acquire(); releaseBody(); assert.equal((await waitingBody).status, 409); unlock(); bodyGate = null;
    assert.equal(auxiliary.busy, false);
    console.log('LITERATURE_AUXILIARY_ROUTE_TESTS_PASS');
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('yanxu-aux-test-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
