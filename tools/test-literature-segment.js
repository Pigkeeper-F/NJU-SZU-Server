'use strict';

// Isolated snapshots and injected PDF preflight: no browser, search or model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const { LiteratureAuxiliary } = require('./literature-auxiliary');
const segment = require('./literature-segment');
const { applyInputCoverage } = require('./literature-extract');
const SOURCE = '11111111-1111-4111-8111-111111111111', MATERIALS = '22222222-2222-4222-8222-222222222222';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(dir, relative, value) {
  const target = path.join(dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
}
function hashes(dir) {
  const result = {};
  function walk(prefix) { for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(name); else result[name] = sha(fs.readFileSync(path.join(dir, name)));
  } } walk(''); return result;
}
function fixture(root) {
  const dir = path.join(root, '.workbench/literature', SOURCE);
  const records = Array.from({ length: 10 }, (_, index) => ({ candidate_id: 'PMID-' + String(index + 1).padStart(3, '0'), title: 'Source study ' + (index + 1), doi: '10.0000/fixture-' + index, source_key: 'pubmed' }));
  const config = { topic: 'Frozen broiler study', query: 'frozen source search', sources: ['pubmed'], limit: 10, fieldDefinitions: [] };
  write(dir, 'run_config.json', config); write(dir, 'candidates.json', { records, count: 10 }); write(dir, 'candidates.csv', 'original candidate csv\n');
  write(dir, 'dedupe/dedupe.json', { version: 1, groups: records.map(record => ({ canonical_id: record.candidate_id, records: [record] })) });
  write(dir, 'dedupe/dedupe.csv', 'original group csv\n');
  const fields = [{ key: 'temperature', label: '温度', meaning: '实验报告的温度', unit: '原文单位', valueType: 'number', required: false }];
  const at = '2026-10-26T04:00:00.000Z'; write(dir, 'confirmations.json', { records: [{ at, by: 'researcher', kind: 'fieldDefinitions', fields }] });
  const schema = segment.fields(dir), items = [], papers = [];
  for (const record of records) {
    const id = record.candidate_id, relative = 'fulltext/files/' + id + '.pdf';
    const bytes = '%PDF-1.4\n' + record.title + '\n' + 'verified fixture bytes '.repeat(80) + '\n%%EOF\n';
    write(dir, relative, bytes);
    const item = { paper_id: id, title: record.title, doi: record.doi, status: 'fetched_pdf', kind: 'pdf', path: relative, size: Buffer.byteLength(bytes), content_sha256: sha(bytes) };
    const paper = { paper_id: id, title: record.title, main_pdf_status: 'downloaded', supplement_check: { status: 'none_found' }, materials: [
      { material_id: 'main-pdf', role: 'main_pdf', path: relative, download_status: 'downloaded', sha256: sha(bytes), size: Buffer.byteLength(bytes), format: 'pdf', label: 'Main PDF' }
    ] };
    items.push(item); papers.push(paper);
  }
  write(dir, 'fulltext/status.json', { version: 1, items }); write(dir, 'fulltext/materials.json', { version: 1, papers });
  for (const item of items) {
    const id = item.paper_id, paper = papers.find(paper => paper.paper_id === id);
    const bundle = { paper_id: id, schema_sha256: schema.sha256, field_definitions: fields, fulltext: { kind: 'pdf', path: item.path, content_sha256: item.content_sha256, text: 'Original selected paper text' }, materials_fingerprint: segment.materialFingerprint(paper) };
    if (id === 'PMID-002') bundle.fulltext.kind = 'html'; // old HTML extraction cannot be reused with new PDF
    if (id === 'PMID-003') bundle.schema_sha256 = 'f'.repeat(64);
    if (['PMID-008', 'PMID-009'].includes(id)) { bundle.input_coverage = { version: 'extract-input-coverage-v1', limitations: ['Only part of the input was supplied'] }; bundle.fulltext.truncated = true; }
    let result = { paper_id: id, source_pdf: id + '.pdf', status: 'ok', rows: [{ row_id: id + '-r1', field: 'temperature', value_raw: '30', evidence: { where: 'Table 1', quote: '30 degrees' } }], warnings: [] };
    if (id === 'PMID-009') result = applyInputCoverage(bundle, result);
    write(dir, 'extraction/inputs/' + id + '.json', bundle);
    write(dir, 'extraction/' + id + '.json', result);
  }
  // Excluded old navigation and HTML are retained in the source only.
  write(dir, 'fulltext/materials/PMID-010/navigation.html', '<html>Old excluded navigation</html>');
  papers[9].materials.push({ material_id: 'old-nav', role: 'supplement', path: 'fulltext/materials/PMID-010/navigation.html', download_status: 'downloaded', excluded_from_supplement_counts: true, sha256: sha('<html>Old excluded navigation</html>'), size: 36 });
  write(dir, 'fulltext/materials.json', { version: 1, papers });
  write(dir, 'validation/validation.json', { version: 1, schema_source: 'confirmations.json#fieldDefinitions@' + at, generated_at: at,
    counts: { parameters_total: 10 }, blocking: [], pending: [{ paper_id: 'PMID-009', entity: 'parameter', index: 0, rules: ['missing_unit'] }] });
  write(dir, 'validation/validation.md', 'Original full ten-paper validation\n');
  write(dir, 'export/parameters.csv', 'Original 259-row downstream artifact\n');
  write(dir, 'job.json', { id: SOURCE, config, status: 'completed', stage: 'completed', until: 'export', resumeStage: null,
    stages: Object.fromEntries(STAGES.map(stage => [stage, 'done'])), files: [], counters: { parameterRows: 259 } });
  const materialDir = path.join(root, '.workbench/literature', MATERIALS);
  fs.cpSync(dir, materialDir, { recursive: true });
  for (const name of ['extraction', 'validation', 'export']) fs.rmSync(path.join(materialDir, name), { recursive: true });
  fs.unlinkSync(path.join(materialDir, 'confirmations.json'));
  const names = ['run_config.json', 'candidates.json', 'candidates.csv', 'dedupe/dedupe.json', 'dedupe/dedupe.csv'];
  const keys = ['configSnapshotSha256', 'candidateSnapshotSha256', 'candidateCsvSnapshotSha256', 'dedupeSnapshotSha256', 'dedupeCsvSnapshotSha256'];
  const inputs = Object.fromEntries(names.map((name, index) => [keys[index], sha(fs.readFileSync(path.join(materialDir, name)))]));
  const basis = { version: 1, kind: 'material-replenishment', parentJobId: SOURCE, candidateCount: 10, createdAt: at, ...inputs, snapshotSha256: sha(JSON.stringify(inputs)) };
  write(materialDir, 'materials-basis.json', basis);
  write(materialDir, 'job.json', { ...read(path.join(dir, 'job.json')), id: MATERIALS, until: 'fulltext',
    stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe', 'fulltext'].includes(stage) ? 'done' : 'pending'])),
    materialReplenishment: { parentJobId: SOURCE, candidateCount: 10, createdAt: at, snapshotSha256: basis.snapshotSha256 } });
  return { dir, materialDir, fields };
}
async function settle(connector, id) {
  for (let i = 0; i < 200; i++) { const job = connector.snapshot(id); if (job.status !== 'running') return job; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('fixture worker did not settle');
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-segment-'));
  try {
    const { dir, materialDir, fields } = fixture(root), original = hashes(dir), originalMaterials = hashes(materialDir), calls = [];
    let preflights = 0;
    const connector = new LiteratureConnector(root, { prepare: async () => 'mock-python', segmentPreflight: async (source, ids) => {
      preflights++; assert.equal(connector.segmentPreparing, true); return ids.map(paperId => ({ paperId, allowed: true }));
    } });
    const preview = connector.segmentPreview(MATERIALS);
    assert.equal(preview.papers.length, 10); assert.equal(preview.schemaSourceJobId, SOURCE); assert.deepEqual(preview.suggestedFields, fields);
    assert.ok(preview.papers.every(paper => paper.eligible.extract.allowed && !paper.eligible.validate.allowed && !paper.eligible.export.allowed));
    const parentPreview = connector.segmentPreview(SOURCE);
    assert.equal(parentPreview.papers[0].eligible.export.allowed, true);
    assert.equal(parentPreview.papers[1].eligible.validate.allowed, false, 'old HTML extraction cannot be applied to a PDF');
    assert.equal(parentPreview.papers[2].eligible.validate.allowed, false, 'schema mismatch is disabled');
    assert.equal(parentPreview.papers[7].eligible.validate.allowed, false, 'a newly marked truncated input cannot bypass coverage warnings through validate');
    assert.equal(parentPreview.papers[8].eligible.validate.allowed, true, 'a correctly partial result with coverage warnings can be reused');
    const selected = ['PMID-001', 'PMID-005', 'PMID-006', 'PMID-007', 'PMID-010'];
    const data = { sourceJobId: MATERIALS, paperIds: selected, fromStage: 'extract', until: 'export', requestId: crypto.randomUUID() };
    connector.runStage = async () => { throw new Error('creation must never start a stage'); };
    const job = await connector.createSegmentTask(data);
    assert.equal(job.status, 'needs_attention'); assert.equal(job.stage, 'awaiting_confirmation'); assert.equal(job.resumeStage, 'extract');
    assert.equal(job.segmentTask.schemaLocked, false); assert.deepEqual(job.segmentTask.paperIds, selected);
    assert.equal(job.segmentTask.fieldsConfirmed, false);
    assert.equal(preflights, 1); assert.equal(connector.segmentPreparing, false);
    const jobDir = path.join(root, '.workbench/literature', job.id);
    assert.deepEqual(read(path.join(jobDir, 'candidates.json')).records.map(record => record.candidate_id), selected);
    assert.deepEqual(read(path.join(jobDir, 'dedupe/dedupe.json')).groups.map(group => group.canonical_id), selected);
    assert.equal(read(path.join(jobDir, 'fulltext/status.json')).counts.fetched_pdf, 5);
    assert.equal(read(path.join(jobDir, 'fulltext/status.json')).counts.materials_complete, 5);
    assert.equal(job.counters.fulltextFetched, 5); assert.equal(job.counters.materialsComplete, 5); assert.equal(job.counters.parameterRows, 0);
    assert.equal(read(path.join(jobDir, 'fulltext/materials.json')).papers[4].materials.length, 1, 'excluded navigation never enters extraction inputs');
    for (const name of ['materials-basis.json', 'extraction', 'validation', 'export', 'confirmations.json', 'fulltext/materials/PMID-010/navigation.html']) assert.equal(fs.existsSync(path.join(jobDir, name)), false);
    assert.equal((await connector.createSegmentTask(data)).id, job.id); assert.equal(preflights, 1, 'same request is reused without another preflight or worker');
    await assert.rejects(connector.createSegmentTask({ ...data, until: 'extract' }), /请求标识/);
    assert.throws(() => connector.advance(job.id), /确认.*字段/);
    for (const options of [{ until: 'fulltext' }, { until: 'discover' }, { deferAccess: true }, { retrySkipped: true }, { confirmSegment: false }]) assert.throws(() => connector.advance(job.id, options));
    assert.throws(() => connector.replenishMaterials(job.id), /分段/);
    assert.throws(() => new LiteratureAuxiliary(root, connector).job(job.id), /分段/);
    const newFields = [{ ...fields[0], unit: '摄氏度', meaning: '本次研究者确认的摄氏温度' }];
    connector.extract = async (_job, _python, emit) => {
      calls.push('extract'); const schema = segment.fields(_job.dir);
      assert.deepEqual(schema.fields, newFields, 'fresh schema can be edited after creation');
      for (const paperId of selected) {
        const status = read(path.join(_job.dir, 'fulltext/status.json')).items.find(item => item.paper_id === paperId);
        const paper = read(path.join(_job.dir, 'fulltext/materials.json')).papers.find(item => item.paper_id === paperId);
        write(_job.dir, 'extraction/inputs/' + paperId + '.json', { paper_id: paperId, schema_sha256: schema.sha256, field_definitions: schema.fields,
          fulltext: { kind: 'pdf', path: status.path, content_sha256: status.content_sha256 }, materials_fingerprint: segment.materialFingerprint(paper) });
        write(_job.dir, 'extraction/' + paperId + '.json', { paper_id: paperId, status: 'ok', rows: [] });
      }
      emit({ type: 'result', stage: 'extraction', count: selected.length, files: [] });
    };
    connector.runStage = async (script, _args, _job, emit) => {
      const stage = script.includes('validate') ? 'validate' : script.includes('export') ? 'export' : 'forbidden'; calls.push(stage);
      if (stage === 'validate') {
        const schema = segment.fields(_job.dir); write(_job.dir, 'validation/validation.json', { version: 1, schema_source: 'confirmations.json#fieldDefinitions@' + schema.record.at, blocking: [], pending: [] });
      }
      emit({ type: 'result', stage, count: selected.length, files: [] });
    };
    connector.advance(job.id, { confirmations: { fields: newFields } });
    const done = await settle(connector, job.id); assert.equal(done.status, 'completed'); assert.equal(done.resumeStage, null);
    assert.equal(done.segmentTask.fieldsConfirmed, true);
    assert.equal(connector.list(20).find(item => item.id === job.id).segmentTask.fieldsConfirmed, true);
    assert.equal(new LiteratureConnector(root).snapshot(job.id).segmentTask.fieldsConfirmed, true);
    assert.deepEqual(calls, ['extract', 'validate', 'export']);
    assert.throws(() => connector.advance(job.id), /全部阶段/);
    assert.deepEqual(hashes(dir), original); assert.deepEqual(hashes(materialDir), originalMaterials);
    // Reuse just the matching prior results; each start skips earlier workers.
    const previous = ['PMID-001', 'PMID-005'];
    for (const fromStage of ['validate', 'export']) {
      const reused = await connector.createSegmentTask({ sourceJobId: SOURCE, paperIds: previous, fromStage, until: 'export', requestId: crypto.randomUUID() });
      assert.equal(reused.segmentTask.schemaLocked, true); assert.equal(reused.stage, 'awaiting_segment_confirmation');
      assert.equal(reused.counters.extractedPapers, 2); assert.equal(reused.counters.parameterRows, 2);
      assert.throws(() => connector.advance(reused.id), /确认分段/);
      assert.throws(() => connector.advance(reused.id, { confirmations: { fields: newFields }, confirmSegment: true }), /字段版本已冻结/);
      const before = calls.length; connector.advance(reused.id, { confirmSegment: true });
      assert.equal((await settle(connector, reused.id)).resumeStage, null);
      assert.deepEqual(calls.slice(before), fromStage === 'validate' ? ['validate', 'export'] : ['export']);
    }
    const stopped = await connector.createSegmentTask({ sourceJobId: MATERIALS, paperIds: ['PMID-001', 'PMID-005'], fromStage: 'extract', until: 'extract', requestId: crypto.randomUUID() });
    connector.cancel(stopped.id);
    assert.throws(() => connector.advance(stopped.id), /确认.*字段/, 'stopping before confirmation cannot bypass the field gate');
    let finishStopped;
    connector.extract = async running => new Promise(resolve => {
      write(running.dir, 'extraction/PMID-001.json', { paper_id: 'PMID-001', status: 'ok', rows: [] });
      running.child = { kill() {} }; finishStopped = resolve;
    });
    connector.advance(stopped.id, { confirmations: { fields } }); await new Promise(resolve => setImmediate(resolve));
    connector.cancel(stopped.id);
    const completedPaperHash = sha(fs.readFileSync(path.join(root, '.workbench/literature', stopped.id, 'extraction/PMID-001.json')));
    assert.equal(connector.snapshot(stopped.id).resumeStage, 'extract');
    assert.throws(() => connector.advance(stopped.id), /运行|退出/, 'the old stopped worker must exit before resuming');
    connector.jobs.get(stopped.id).child = null; finishStopped(); await new Promise(resolve => setImmediate(resolve));
    connector.extract = async (running, _python, emit) => {
      assert.equal(sha(fs.readFileSync(path.join(running.dir, 'extraction/PMID-001.json'))), completedPaperHash, 'a completed paper survives stop/resume');
      write(running.dir, 'extraction/PMID-005.json', { paper_id: 'PMID-005', status: 'ok', rows: [] }); emit({ type: 'result', stage: 'extraction', count: 2, files: [] });
    };
    connector.advance(stopped.id); assert.equal((await settle(connector, stopped.id)).status, 'completed');
    assert.equal(connector.snapshot(stopped.id).resumeStage, null, 'resume cannot escape the segment end');
    const narrow = await connector.createSegmentTask({ sourceJobId: MATERIALS, paperIds: ['PMID-001'], fromStage: 'extract', until: 'extract', requestId: crypto.randomUUID() });
    assert.throws(() => connector.advance(narrow.id, { until: 'validate', confirmations: { fields } }), /分段范围/);
    const narrowDir = path.join(root, '.workbench/literature', narrow.id), saved = read(path.join(narrowDir, 'job.json'));
    write(narrowDir, 'job.json', { ...saved, status: 'running', activeStage: 'extract', resumeStage: 'fulltext', until: 'export' });
    const restarted = new LiteratureConnector(root);
    assert.equal(restarted.snapshot(narrow.id).resumeStage, 'extract'); assert.equal(restarted.snapshot(narrow.id).until, 'extract');
    assert.equal(restarted.snapshot(narrow.id).status, 'failed');
    const marker = fs.readFileSync(path.join(narrowDir, segment.MARKER)); fs.unlinkSync(path.join(narrowDir, segment.MARKER));
    assert.equal(restarted.snapshot(narrow.id).segmentInvalid, true);
    assert.throws(() => restarted.advance(narrow.id, { confirmations: { fields } }), /缺失|安全/);
    fs.writeFileSync(path.join(narrowDir, segment.MARKER), marker);
    write(narrowDir, 'fulltext/files/PMID-001.pdf', 'tampered original');
    assert.throws(() => restarted.advance(narrow.id, { confirmations: { fields } }), /冻结输入/);
    assert.deepEqual(hashes(dir), original); assert.deepEqual(hashes(materialDir), originalMaterials);
    // Async PDF preflight locks mutations, releases even after failure.
    let release;
    const blocking = new LiteratureConnector(root, { segmentPreflight: async () => new Promise(resolve => { release = resolve; }) });
    const pending = blocking.createSegmentTask({ ...data, requestId: crypto.randomUUID() });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(blocking.segmentPreparing, true);
    assert.throws(() => blocking.start({ topic: 'x', query: 'x', sources: ['pubmed'] }), /冻结分段/);
    assert.throws(() => blocking.deleteJob(SOURCE), /冻结分段/);
    release(selected.map(paperId => ({ paperId, allowed: false, reason: 'fixture unreadable PDF' })));
    await assert.rejects(pending, /unreadable/); assert.equal(blocking.segmentPreparing, false);
    console.log('LITERATURE_SEGMENT_TESTS_PASS');
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('yanxu-segment-')) throw new Error('Unsafe fixture directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
