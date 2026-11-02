'use strict';
// Production screening and pipeline with local fixtures and a mock transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const screening = require('./literature-screening');
const { runScreeningPipeline } = require('./literature-screening-pipeline');
const root = path.resolve(__dirname, '..'), base = path.join(root, '.tmp-literature-tests');
fs.mkdirSync(base, { recursive: true });
const policy = { id: 'BATCH-TEST', line: 'production', text: '整体动物生产结果；信息不足待定；明确非目标排除。' };
const row = id => ({ candidate_id: id, source_key: 'cnki', title: `${id} broiler heat exposure`,
  abstract: 'Broilers exposed to heat were compared with thermoneutral controls. Growth and intake were measured.' });
const write = (dir, name, value) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
function bridge() {
  const calls = [], replies = new Map();
  return { calls, createSession: () => ({ id: 'offline-batch-session' }),
    async run(session, messages) {
      const bundle = JSON.parse(messages[0].content.split('【本篇可用原始证据；全文尚未下载】\n')[1].split('\n只判断本篇')[0]);
      calls.push(bundle.paper_id); const id = `run-${calls.length}`;
      const decision = bundle.paper_id === 'R2' ? 'exclude' : 'include';
      replies.set(id, { id, status: 'completed', text: JSON.stringify({ paper_id: bundle.paper_id, decision,
        reason: 'Fixture eligibility evidence.', exclusionRule: decision === 'exclude' ? 'Fixture exclusion rule' : '',
        evidence: [{ source_id: bundle.documents[0].source_id, field: 'title', quote: bundle.documents[0].title, criterion: 'object' }], uncertainties: [] }) });
      return { id };
    }, snapshot: id => replies.get(id), cancel: async () => {} };
}
async function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(base, 'batch-scope-'));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function test() {
  await isolated(async dir => {
    const records = ['R1', 'R2', 'R3'].map(row); write(dir, 'candidates.json', { records });
    const model = bridge(), options = { root, bridge: model, jobDir: dir, config: { screeningPolicy: policy } };
    const first = await screening.runScreeningStage({ ...options, paperIds: ['R1'] });
    assert.deepEqual(model.calls, ['R1']);
    assert.deepEqual(first.counts, { include: 1, pending: 0, exclude: 0, unscreened: 2 });
    assert.deepEqual(first.batchCounts, { include: 1, pending: 0, exclude: 0 });
    const checkpoint = read(dir, 'screening/status.json').records.R1;
    const second = await screening.runScreeningStage({ ...options, paperIds: ['R2'] });
    assert.deepEqual(second.counts, { include: 1, pending: 0, exclude: 1, unscreened: 1 });
    assert.deepEqual(read(dir, 'screening/status.json').records.R1, checkpoint);
    assert.equal(read(dir, 'screening/status.json').records.R3, undefined);
    const resumed = await screening.runScreeningStage({ ...options, paperIds: ['R1'] });
    assert.equal(resumed.reused, 1); assert.deepEqual(model.calls, ['R1', 'R2']);
    const full = await screening.runScreeningStage(options);
    assert.deepEqual(full.counts, { include: 2, pending: 0, exclude: 1 });
    assert.deepEqual(model.calls, ['R1', 'R2', 'R3']);
    records[0].abstract += ' The original abstract has changed.'; write(dir, 'candidates.json', { records });
    await screening.runScreeningStage({ ...options, paperIds: ['R1'] });
    assert.deepEqual(model.calls, ['R1', 'R2', 'R3', 'R1'], 'input hash change cannot reuse prior judgment');
  });

  await isolated(async dir => {
    write(dir, 'candidates.json', { records: [row('R1')] }); const model = bridge();
    for (const paperIds of [null, [], ['R1', 'R1'], ['foreign'], ['../R1'], 'R1']) {
      await assert.rejects(screening.runScreeningStage({ root, bridge: model, jobDir: dir, config: { screeningPolicy: policy }, paperIds }),
        error => error.reason === 'screening_scope_invalid');
    }
    assert.deepEqual(model.calls, []); assert.equal(fs.existsSync(path.join(dir, 'screening')), false);
  });

  await isolated(async dir => {
    const records = ['R1', 'DUP', 'R2', 'R3'].map(row);
    write(dir, 'candidates.json', { records });
    write(dir, 'dedupe/dedupe.json', { candidate_input_hash: screening.digest(records), groups: [
      { canonical_id: 'R1', merge_confidence: 'exact', records: records.slice(0, 2) },
      { canonical_id: 'R2', merge_confidence: 'probable', needs_review: true, records: records.slice(2) }
    ] });
    const calls = [], model = bridge(), events = [];
    const options = { root, bridge: model, job: { dir, until: 'fulltext', status: 'running', config: { screeningPolicy: policy } },
      onEvent: e => events.push(e), runMetadata: async (args, emit) => {
        const ids = JSON.parse(args[args.indexOf('--only') + 1]); calls.push(ids);
        emit({ type: 'result', ok: true, complete: true, selected_candidate_ids: ids });
      } };
    const first = await runScreeningPipeline({ ...options, paperIds: ['R1'] });
    assert.deepEqual(calls, [['DUP', 'R1']], 'exact bundle expands all original abstract sources');
    assert.deepEqual(model.calls, ['R1']); assert.deepEqual(first.selectedPaperIds, ['R1']);
    assert.equal(first.counts.unscreened, 2);
    await runScreeningPipeline({ ...options, paperIds: ['R2'] });
    assert.deepEqual(calls[1], ['R2'], 'probable group stays separate; never screens R3 implicitly');
    assert.equal(read(dir, 'screening/status.json').records.R3, undefined);
    const before = model.calls.length;
    await assert.rejects(runScreeningPipeline({ ...options, paperIds: ['R3'], runMetadata: async (_, emit) => {
      emit({ type: 'result', ok: true, complete: true, selected_candidate_ids: ['R1'] });
    } }), e => e.reason === 'screening_scope_invalid');
    assert.equal(model.calls.length, before);
    await assert.rejects(runScreeningPipeline({ ...options, paperIds: ['R3'], screen: async () => ({ ok: true, selectedPaperIds: ['R1'] }) }),
      e => e.reason === 'screening_scope_invalid');
    assert.equal(events.filter(e => e.type === 'result').length, 2, 'metadata never emits a whole-stage completion');
    write(dir, 'candidates.json', { records: [...records, row('R4')] });
    await assert.rejects(runScreeningPipeline({ ...options, paperIds: ['R1'] }), e => e.reason === 'screening_dedupe_stale');
  });
  console.log('BATCH_SCREENING_PASS: subset scopes, exact/probable groups, global counts, resume, hashes and scope guards');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
