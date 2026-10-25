'use strict';

// Isolated fixture: no user task, Python, network or database browser is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const { LiteratureAuxiliary } = require('./literature-auxiliary');
const { backendFingerprint } = require('./literature-runtime');
const ID = '11111111-1111-4111-8111-111111111111';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(dir, name, data) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); }
function fixture(root) {
  const dir = path.join(root, '.workbench/literature', ID);
  const records = Array.from({ length: 10 }, (_, i) => ({ candidate_id: 'PMID-' + String(i + 1).padStart(3, '0'), title: 'Original study ' + i, source_key: 'pubmed', doi: '10.0000/fixture-' + i }));
  const config = { version: 2, topic: 'original broiler fixture', query: 'original frozen query', sources: ['pubmed'], limit: 10, targetFields: ['temperature'] };
  const body = 'Verified original fixture body, must remain byte-identical.';
  const supplement = 'supplementary original CSV\nvalue\n1\n';
  write(dir, 'run_config.json', config); write(dir, 'candidates.json', { count: 10, records, discovery_complete: true, batches: [{ batch_index: 1, status: 'complete' }] });
  write(dir, 'candidates.csv', 'candidate_id,title\n' + records.map(r => r.candidate_id + ',' + r.title).join('\n'));
  write(dir, 'dedupe/dedupe.json', { version: 1, groups: records.map(record => ({ canonical_id: record.candidate_id, title: record.title, records: [record] })) });
  write(dir, 'dedupe/dedupe.csv', 'canonical_id\n' + records.map(r => r.candidate_id).join('\n'));
  write(dir, 'fulltext/files/PMID-001.txt', body);
  write(dir, 'fulltext/materials/PMID-001/table.csv', supplement);
  write(dir, 'fulltext/status.json', { version: 1, items: records.map((record, i) => ({ paper_id: record.candidate_id, title: record.title,
    status: i ? 'unavailable' : 'fetched_html', path: i ? '' : 'fulltext/files/PMID-001.txt', size: i ? 0 : Buffer.byteLength(body),
    ...(i ? { acquisition_skip: { policy: 'skip_unavailable' } } : { content_sha256: sha(body) }) })) });
  write(dir, 'fulltext/materials.json', { version: 1, papers: records.map((record, i) => ({ paper_id: record.candidate_id, title: record.title,
    main_pdf_status: 'missing', supplement_check: { status: 'unknown' }, materials: i ? [] : [
      { material_id: 'main-html', role: 'main_html', path: 'fulltext/files/PMID-001.txt', sha256: sha(body), size: Buffer.byteLength(body), download_status: 'downloaded' },
      { material_id: 'table', role: 'supplement', path: 'fulltext/materials/PMID-001/table.csv', sha256: sha(supplement), size: Buffer.byteLength(supplement), download_status: 'downloaded' }
    ] })) });
  for (const name of ['extraction/PMID-001.json', 'validation/validation.json', 'export/parameters.csv', 'export/literature.xlsx', 'confirmations.json']) write(dir, name, 'original downstream bytes\n');
  write(dir, 'fulltext-browser.json', { target_id: 'do-not-copy-browser-state' });
  write(dir, 'job.json', { id: ID, config, status: 'completed', stage: 'completed', until: 'export', resumeStage: null,
    stages: Object.fromEntries(STAGES.map(stage => [stage, 'done'])), counters: { candidates: 10, uniqueGroups: 10, parameterRows: 259 },
    count: 259, files: ['run_config.json', 'candidates.json', 'export/parameters.csv'], events: [] });
  return dir;
}
function hashes(dir) {
  const result = {};
  function walk(relative) { for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name); if (entry.isDirectory()) walk(name); else result[name] = sha(fs.readFileSync(path.join(dir, name)));
  } } walk(''); return result;
}
async function settle(connector, id) {
  for (let i = 0; i < 100; i++) { const current = connector.snapshot(id); if (current.status !== 'running') return current; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('fixture did not settle');
}
function routeHandler(root, connector) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const a = source.indexOf('async function handleLiterature('), b = source.indexOf('\n}', a);
  const context = vm.createContext({ scholar: connector, literatureAuxiliary: new LiteratureAuxiliary(root, connector),
    readBody: async req => JSON.stringify(req.body), sendJson: (res, status, data) => Object.assign(res, { status, data }) });
  vm.runInContext(source.slice(a, b + 2) + '\nglobalThis.handle=handleLiterature;', context);
  return async body => { const res = {}; await context.handle({ method: 'POST', body }, res, new URL('http://fixture/api/literature/replenish-materials')); return res; };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-replenishment-'));
  try {
    const dir = fixture(root), original = hashes(dir), workerCalls = [];
    let gateRelease;
    const gate = new Promise(resolve => { gateRelease = resolve; });
    let connector = new LiteratureConnector(root, { prepare: async () => { await gate; return 'mock-python'; } });
    connector.runStage = async (script, args, job, emit) => {
      workerCalls.push({ script, args });
      assert.equal(script, 'literature_fulltext.py'); assert.deepEqual(args, ['--replenish-materials', '--resume']);
      assert.notEqual(job.id, ID); assert.equal(job.config.query, 'original frozen query');
      for (const relative of ['run_config.json', 'candidates.json', 'candidates.csv', 'dedupe/dedupe.json', 'dedupe/dedupe.csv', 'fulltext/files/PMID-001.txt', 'fulltext/materials/PMID-001/table.csv']) {
        assert.deepEqual(fs.readFileSync(path.join(job.dir, relative)), fs.readFileSync(path.join(dir, relative)));
      }
      for (const relative of ['extraction', 'validation', 'export', 'confirmations.json', 'fulltext-browser.json']) assert.equal(fs.existsSync(path.join(job.dir, relative)), false);
      assert.equal(job.stages.discover, 'done'); assert.equal(job.stages.dedupe, 'done');
      emit({ type: 'attention', stage: 'fulltext', source: 'pubmed', reason: 'login', message: 'fixture login required' });
    };
    assert.equal(connector.snapshot(ID).canReplenishMaterials, true);
    assert.deepEqual(hashes(dir), original, 'read-only capability never rewrites original task');
    const route = routeHandler(root, connector);
    for (const body of [{ id: ID, until: 'export' }, { id: ID, config: {} }, {}, { id: '../bad' }]) assert.equal((await route(body)).status, 400);
    const accepted = await route({ id: ID }); assert.equal(accepted.status, 202);
    const child = accepted.data; assert.notEqual(child.id, ID); assert.equal(child.until, 'fulltext');
    assert.equal(child.materialReplenishment.parentJobId, ID); assert.equal(child.materialReplenishment.candidateCount, 10);
    assert.equal(child.canReplenishMaterials, false);
    const duplicate = await route({ id: ID }); assert.equal(duplicate.data.id, child.id); assert.equal(workerCalls.length, 0);
    gateRelease(); const paused = await settle(connector, child.id);
    assert.equal(paused.status, 'needs_attention'); assert.equal(paused.resumeStage, 'fulltext'); assert.equal(workerCalls.length, 1);
    assert.equal((await route({ id: ID })).data.id, child.id); assert.equal(workerCalls.length, 1, 'a repeated parent action cannot resume a paused child');
    assert.deepEqual(hashes(dir), original, 'creating and pausing a child preserves every parent file');
    const childDir = path.join(root, '.workbench/literature', child.id);
    assert.equal(connector.download(child.id, 'materials-basis.json'), path.join(childDir, 'materials-basis.json'));
    assert.equal(connector.list(20).find(item => item.id === child.id).materialReplenishment.parentJobId, ID);
    assert.throws(() => connector.advance(child.id, { until: 'export' }), /只获取/);
    assert.throws(() => connector.advance(child.id, { confirmations: { fields: [] } }), /只获取/);
    assert.throws(() => connector.advance(child.id, { skipUnavailable: true }), /只获取/);
    assert.throws(() => connector.replenishMaterials(child.id), /补齐记录/);
    // Simulate process death while acquiring: restoration stays materials-only
    // even though copied fulltext progress already has no pending items.
    const saved = json(path.join(childDir, 'job.json')); saved.status = 'running'; saved.until = 'export'; saved.resumeStage = 'extract'; write(childDir, 'job.json', saved);
    connector = new LiteratureConnector(root, { prepare: async () => 'mock-python' });
    assert.equal(connector.snapshot(child.id).resumeStage, 'fulltext'); assert.equal(connector.snapshot(child.id).until, 'fulltext');
    assert.equal(connector.replenishMaterials(ID).id, child.id); assert.equal(connector.jobs.size, 0, 'restart recovery does not launch or load a worker');
    connector.runStage = async (script, args, job, emit) => { workerCalls.push({ script, args }); assert.equal(script, 'literature_fulltext.py');
      emit({ type: 'result', stage: 'fulltext', count: 1, counts: { fetched_html: 1 }, files: ['fulltext/status.json'] }); };
    connector.advance(child.id);
    const done = await settle(connector, child.id); assert.equal(done.status, 'completed'); assert.equal(done.resumeStage, null); assert.equal(done.until, 'fulltext');
    assert.equal(connector.replenishMaterials(ID).id, child.id); assert.equal(workerCalls.length, 2, 'completed child is reused without redownloading');
    assert.throws(() => connector.advance(child.id), /全部阶段/);
    assert.deepEqual(hashes(dir), original);
    const helper = new LiteratureAuxiliary(root, connector); assert.throws(() => helper.job(child.id), /仅用于/);
    // A saved child cannot be promoted by editing its frozen candidate input.
    const candidates = json(path.join(childDir, 'candidates.json')); candidates.records[0].title = 'tampered'; write(childDir, 'candidates.json', candidates);
    assert.throws(() => connector.advance(child.id), /冻结输入/);
    assert.deepEqual(hashes(dir), original);
    fs.unlinkSync(path.join(childDir, 'materials-basis.json'));
    const missingMarker = new LiteratureConnector(root);
    assert.equal(missingMarker.snapshot(child.id).replenishmentInvalid, true);
    assert.equal(missingMarker.snapshot(child.id).until, 'fulltext');
    assert.throws(() => missingMarker.advance(child.id, { until: 'extract' }), /冻结输入/);
    assert.throws(() => missingMarker.advance(child.id), /冻结输入/);
    assert.throws(() => missingMarker.replenishMaterials(child.id), /补齐记录/);
    const existingRecords = fs.readdirSync(connector.base).sort();
    assert.throws(() => missingMarker.replenishMaterials(ID), /记录不完整/);
    assert.deepEqual(fs.readdirSync(connector.base).sort(), existingRecords, 'Missing marker must not create a duplicate child');
    // Invalid source hashes and unsafe paths are rejected before any child is created.
    const invalidRoot = path.join(root, 'invalid'); const invalidDir = fixture(invalidRoot);
    const badManifest = json(path.join(invalidDir, 'fulltext/materials.json')); badManifest.papers[0].materials[0].sha256 = 'f'.repeat(64); write(invalidDir, 'fulltext/materials.json', badManifest);
    const badHashStatus = json(path.join(invalidDir, 'fulltext/status.json')); badHashStatus.items[0].content_sha256 = 'f'.repeat(64); write(invalidDir, 'fulltext/status.json', badHashStatus);
    const guarded = new LiteratureConnector(invalidRoot);
    assert.equal(guarded.snapshot(ID).canReplenishMaterials, true, 'Capability does not rehash original attachments on every poll');
    assert.throws(() => guarded.replenishMaterials(ID), /SHA/, 'Explicit action rehashes and rejects a tampered attachment before copying or running');
    assert.equal(fs.readdirSync(path.dirname(invalidDir)).length, 1);
    fixture(invalidRoot); const badStatus = json(path.join(invalidDir, 'fulltext/status.json')); badStatus.items[0].path = '../outside.txt'; write(invalidDir, 'fulltext/status.json', badStatus);
    assert.throws(() => new LiteratureConnector(invalidRoot).replenishMaterials(ID), /路径/);
    fixture(invalidRoot); const deleted = json(path.join(invalidDir, 'job.json')); deleted.deletedAt = new Date().toISOString(); write(invalidDir, 'job.json', deleted);
    assert.throws(() => new LiteratureConnector(invalidRoot).replenishMaterials(ID), /删除/);
    fixture(invalidRoot); const busy = new LiteratureConnector(invalidRoot); busy.jobs.set(ID, { ...json(path.join(invalidDir, 'job.json')), status: 'running' });
    assert.throws(() => busy.replenishMaterials(ID), /运行/);
    const fingerprint = backendFingerprint(root); write(root, 'tools/literature-material-replenishment.js', '// changed acquisition scope');
    assert.notEqual(backendFingerprint(root), fingerprint);
    console.log('LITERATURE_MATERIAL_REPLENISHMENT_TESTS_PASS');
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('yanxu-replenishment-')) throw new Error('Unexpected fixture directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
