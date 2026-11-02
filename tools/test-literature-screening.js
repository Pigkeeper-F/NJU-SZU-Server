'use strict';
// Isolated files + mock Codex transport. Never starts a browser or real model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const screening = require('./literature-screening');
const root = path.resolve(__dirname, '..');
const policy = { id: 'TEST-PRODUCTION-v1', line: 'production', text: '目标动物生产原始研究，需环境对照及生产结果；明确不符排除，未知待定。' };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), 'utf8'); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function savedPdf(dir, paperId = 'R1') {
  const relative = `fulltext/files/${paperId}.pdf`, file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '%PDF-1.4\nStatus-backed fixture; PDF parsing belongs to acquisition.\n%%EOF');
  write(path.join(dir, 'fulltext/status.json'), { items: [{ paper_id: paperId,
    status: 'fetched_pdf', kind: 'pdf', path: relative, size: fs.statSync(file).size }] });
  return { path: relative, pages: '2-3' };
}
const row = (id, extra = {}) => ({ candidate_id: id, source_key: 'scopus', title: 'Heat stress and broiler growth',
  abstract: 'Broilers were allocated to thermoneutral and heat stress groups. Weight gain was measured.',
  keywords: ['heat stress', 'growth'], ...extra });
function job(dir, records = [row('R1')]) { write(path.join(dir, 'candidates.json'), { records }); }
function bundleFromPrompt(prompt) {
  return JSON.parse(prompt.split('【本篇可用原始证据；全文尚未下载】\n')[1].split('\n只判断本篇')[0]);
}
function answer(bundle, decision = 'include') {
  return { paper_id: bundle.paper_id, decision, reason: '温度对照与生产终点有直接证据。',
    exclusionRule: decision === 'exclude' ? '测试明确不符条款' : '',
    evidence: [{ source_id: bundle.documents[0].source_id, field: 'title', quote: bundle.documents[0].title, criterion: '对象和环境' }], uncertainties: [] };
}
function mockBridge(reply) {
  const calls = [], snapshots = new Map(); let cancelled = 0;
  return { calls, get cancelled() { return cancelled; },
    createSession() { return { id: 'screening-test-session' }; },
    async run(session, messages, instructions, execute, model, moduleType) {
      const id = `mock-${calls.length + 1}`, bundle = bundleFromPrompt(messages[0].content);
      calls.push({ bundle, execute, instructions, model, moduleType });
      const value = reply ? reply(bundle, calls.length) : answer(bundle);
      snapshots.set(id, { id, status: 'completed', model: 'test-model', text: typeof value === 'string' ? value : JSON.stringify(value) });
      return { id };
    }, snapshot(id) { return snapshots.get(id); }, async cancel() { cancelled += 1; } };
}
async function isolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-screening-'));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('real bridge interface persists cited decisions and resumes without new model calls', () => isolated(async dir => {
  job(dir); const bridge = mockBridge();
  const run = screening.createScreeningStage({ root, bridge });
  const result = await run({ jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(result.counts.include, 1); assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].execute, false); assert.equal(bridge.calls[0].moduleType, 'literature-mining');
  const saved = read(path.join(dir, 'screening/status.json')).records.R1;
  assert.equal(saved.reviewer.type, 'codex'); assert.equal(saved.reviewer.runId, 'mock-1');
  assert.equal(saved.inputHash, screening.digest(screening.loadInputs(dir)[0]));
  const again = await run({ jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(again.reused, 1); assert.equal(bridge.calls.length, 1);
}));

test('batch budget reports only durable new decisions and resume reuses their evidence', () => isolated(async dir => {
  job(dir, [row('R1'), row('R2')]); let now = 0;
  const bridge = mockBridge(bundle => { now = 100; return answer(bundle); });
  await assert.rejects(screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy },
    maxRuntimeMs: 100, now: () => now }), error => error.reason === 'screening_budget' && error.completedThisBatch === 1);
  const saved = read(path.join(dir, 'screening/status.json'));
  assert.equal(saved.records.R1.decision, 'include'); assert.equal(saved.records.R2, undefined);
  assert.equal(saved.last_error.completedThisBatch, 1);
  const resumedBridge = mockBridge();
  const resumed = await screening.runScreeningStage({ root, bridge: resumedBridge, jobDir: dir, config: { screeningPolicy: policy }, now: () => now });
  assert.equal(resumed.reused, 1); assert.equal(resumedBridge.calls.length, 1);
  assert.equal(resumedBridge.calls[0].bundle.paper_id, 'R2');
}));

test('in-flight batch deadline is distinct from a genuine per-paper model timeout', () => isolated(async dir => {
  job(dir, [row('R1'), row('R2')]);
  for (const [maxRuntimeMs, timeoutMs, reason] of [[100, 1000, 'screening_budget'], [1000, 100, 'screening_timeout']]) {
    // A new policy version ensures each case exercises both papers.
    let now = 0; const currentPolicy = { ...policy, id: policy.id + '-' + reason }, bridge = mockBridge();
    const snapshot = bridge.snapshot;
    bridge.snapshot = id => {
      if (id === 'mock-2') { now = 101; return { id, status: 'running' }; }
      return snapshot(id);
    };
    await assert.rejects(screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: currentPolicy },
      maxRuntimeMs, timeoutMs, now: () => now }), error => error.reason === reason
        && (reason !== 'screening_budget' || error.completedThisBatch === 1));
    assert.equal(bridge.cancelled, 1);
    const saved = read(path.join(dir, 'screening/status.json'));
    assert.equal(saved.records.R1.policyId, currentPolicy.id);
    assert.equal(saved.last_error.reason, reason);
  }
}));

test('failure to interrupt a budget-limited model never authorizes another batch', () => isolated(async dir => {
  job(dir); let now = 0; const bridge = mockBridge();
  bridge.snapshot = id => { now = 101; return { id, status: 'running' }; };
  bridge.cancel = async () => { throw new Error('interruption unavailable'); };
  await assert.rejects(screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy },
    maxRuntimeMs: 100, timeoutMs: 1000, now: () => now }), error => error.reason === 'screening_model_error');
  assert.equal(read(path.join(dir, 'screening/status.json')).records.R1, undefined);
}));

test('missing abstract routes directly to pending without model calls; snippet is not an abstract', () => isolated(async dir => {
  job(dir, [row('R1', { abstract: '', snippet: 'Search preview says something', evidence_level: 'search_result_snippet' })]);
  const bridge = mockBridge(bundle => answer(bundle, 'exclude'));
  const result = await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  const saved = read(path.join(dir, 'screening/status.json')).records.R1;
  assert.equal(saved.decision, 'pending'); assert.equal(saved.aiProposedDecision, undefined);
  assert.deepEqual(saved.reviewer, { type: 'rule', ruleId: 'missing-full-abstract-v1' });
  assert.equal(saved.extraction_allowed, false);
  assert.equal(bridge.calls.length, 0); assert.equal(result.modelCalls, 0); assert.equal(result.rulePending, 1);
  assert.equal(screening.loadInputs(dir)[0].documents[0].abstract, '');
  const again = await screening.runScreeningStage({ jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(again.reused, 1); assert.equal(again.rulePending, 0); assert.equal(again.modelCalls, 0);
  job(dir, [row('R1')]);
  const enriched = await screening.runScreeningStage({ root, bridge: mockBridge(), jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(enriched.modelCalls, 1, 'acquired full abstract must invalidate the earlier deterministic decision');
  assert.equal(enriched.counts.include, 1);
}));

test('missing-abstract checkpoint survives later model unavailability and cannot grant eligibility', () => isolated(async dir => {
  job(dir, [row('R1', { abstract: '', title: '', keywords: [] }), row('R2')]);
  await assert.rejects(screening.runScreeningStage({ jobDir: dir, config: { screeningPolicy: policy } }),
    error => error.reason === 'screening_model_unavailable' && error.paperId === 'R2');
  const saved = read(path.join(dir, 'screening/status.json')).records.R1;
  const bundle = screening.loadInputs(dir)[0];
  assert.equal(saved.decision, 'pending'); assert.deepEqual(saved.evidence, []);
  assert.ok(screening.validStored(saved, bundle, policy, dir));
  for (const changed of [{ ...saved, decision: 'include' }, { ...saved, extraction_allowed: true },
    { ...saved, reviewer: { type: 'rule', ruleId: 'any-keyword-exclusion' } }]) {
    assert.equal(screening.validStored(changed, bundle, policy, dir), null);
  }
  const resumed = await screening.runScreeningStage({ jobDir: dir, bridge: mockBridge(), config: { screeningPolicy: policy } });
  assert.equal(resumed.reused, 1); assert.equal(resumed.modelCalls, 1);
}));

test('fabricated quotation or missing model output pauses and never defaults to exclusion', () => isolated(async dir => {
  job(dir);
  for (const response of ['no structured result', bundle => ({ ...answer(bundle, 'exclude'), evidence: [{ source_id: 'R1', field: 'abstract', quote: 'Invented fact.' }] })]) {
    const bridge = mockBridge(typeof response === 'function' ? response : () => response);
    await assert.rejects(screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } }), error => error.code === 'SCREENING_ATTENTION');
    assert.equal(read(path.join(dir, 'screening/status.json')).records.R1, undefined);
  }
}));

test('rule/line and evidence changes require a fresh review while history survives', () => isolated(async dir => {
  job(dir); const bridge = mockBridge();
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  const emissions = { ...policy, id: 'TEST-EMISSION-v1', line: 'emission' };
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: emissions } });
  assert.equal(bridge.calls.length, 2);
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(bridge.calls.length, 2);
  job(dir, [row('R1', { abstract: 'Updated complete abstract includes a third group.' })]);
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(bridge.calls.length, 3);
  assert.equal(Object.keys(read(path.join(dir, 'screening/status.json')).history).length, 3);
}));

test('checkpoint keeps the first paper when the second model call fails', () => isolated(async dir => {
  job(dir, [row('R1'), row('R2')]);
  const failing = mockBridge((bundle, n) => n === 1 ? answer(bundle) : 'failed output');
  await assert.rejects(screening.runScreeningStage({ root, bridge: failing, jobDir: dir, config: { screeningPolicy: policy } }));
  assert.equal(read(path.join(dir, 'screening/status.json')).records.R1.decision, 'include');
  const retry = mockBridge();
  await screening.runScreeningStage({ root, bridge: retry, jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(retry.calls.length, 1); assert.equal(retry.calls[0].bundle.paper_id, 'R2');
}));

test('stale dedupe cannot hide a newly imported paper and probable groups remain independent', () => isolated(async dir => {
  const records = [row('R1'), row('R2')]; job(dir, records);
  write(path.join(dir, 'dedupe/dedupe.json'), { candidate_input_hash: screening.digest(records), groups: [
    { canonical_id: 'R1', merge_confidence: 'probable', needs_review: true, records } ] });
  assert.deepEqual(screening.loadInputs(dir).map(r => r.paper_id), ['R1', 'R2']);
  job(dir, [...records, row('R3')]);
  const bridge = mockBridge();
  await assert.rejects(screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } }), error => error.reason === 'screening_dedupe_stale');
  assert.equal(bridge.calls.length, 0);
}));

test('legacy tasks are unchanged, and an unavailable model is attention for configured tasks', () => isolated(async dir => {
  job(dir);
  assert.equal((await screening.runScreeningStage({ jobDir: dir, config: {} })).skipped_legacy, true);
  assert.equal(fs.existsSync(path.join(dir, 'screening')), false);
  await assert.rejects(screening.runScreeningStage({ jobDir: dir, config: { screeningPolicy: policy } }), error => error.reason === 'screening_model_unavailable');
}));

test('JS persisted hashes and evidence are accepted by Python download gate with pending non-extractable', () => isolated(async dir => {
  job(dir, [row('R1'), row('R2'), row('R3'), row('R4', { abstract: '' })]);
  const bridge = mockBridge(bundle => answer(bundle, { R1: 'include', R2: 'pending', R3: 'exclude' }[bundle.paper_id]));
  write(path.join(dir, 'run_config.json'), { screeningPolicy: policy });
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  const script = 'import json,sys;sys.path.insert(0,sys.argv[1]);from literature_screening import gate_targets,load_inputs;p=json.load(open(sys.argv[2]+"/run_config.json",encoding="utf-8"))["screeningPolicy"];print(json.dumps(gate_targets(sys.argv[2],[{"paper_id":b["paper_id"]} for b in load_inputs(sys.argv[2])],p)))';
  const python = process.env.WORKBENCH_PYTHON || (fs.existsSync(path.join(root, '.venv/Scripts/python.exe')) ? path.join(root, '.venv/Scripts/python.exe') : 'python');
  const checked = spawnSync(python, ['-X', 'utf8', '-c', script, __dirname, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.deepEqual(result.excluded, ['R3']); assert.deepEqual(result.pending, ['R2', 'R4']); assert.deepEqual(result.unscreened, []);
  assert.equal(result.targets.find(r => r.paper_id === 'R2').extraction_allowed, false);
  assert.equal(result.targets.find(r => r.paper_id === 'R4').extraction_allowed, false);
  assert.equal(bridge.calls.length, 3);
  assert.equal(result.targets.find(r => r.paper_id === 'R1').extraction_allowed, true);
}));

test('manual decisions preserve prior AI evidence and resume without overriding researcher choice', () => isolated(async dir => {
  job(dir); const bridge = mockBridge(bundle => answer(bundle, 'pending'));
  await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  const bundle = screening.loadInputs(dir)[0], response = answer(bundle, 'include');
  const result = screening.setManualDecision({ jobDir: dir, config: { screeningPolicy: policy },
    paperId: 'R1', ...response, expectedInputHash: screening.digest(bundle),
    expectedPolicyHash: screening.policyIdentity(policy).policyHash, reviewerName: 'Test researcher' });
  assert.equal(result.record.reviewer.type, 'human');
  assert.equal(result.record.reviewer.name, 'Test researcher');
  assert.equal(result.counts.include, 1);
  const state = read(path.join(dir, 'screening/status.json'));
  assert.equal(state.manualChanges[0].previous.decision, 'pending');
  assert.equal(state.manualChanges[0].previous.reviewer.type, 'codex');
  assert.equal(state.manualChanges[0].record.decision, 'include');
  const retry = await screening.runScreeningStage({ root, bridge, jobDir: dir, config: { screeningPolicy: policy } });
  assert.equal(retry.reused, 1); assert.equal(bridge.calls.length, 1);
  screening.setManualDecision({ jobDir: dir, config: { screeningPolicy: policy }, paperId: 'R1',
    decision: 'pending', reason: 'Researcher requests another check.', expectedInputHash: screening.digest(bundle) });
  const updated = read(path.join(dir, 'screening/status.json'));
  assert.equal(updated.manualChanges.length, 2);
  assert.equal(updated.manualChanges[1].previous.reviewer.type, 'human');
}));

test('manual changes reject stale inputs/rules, fabricated quotations and no-abstract overrides without writes', () => isolated(async dir => {
  job(dir); const bundle = screening.loadInputs(dir)[0], response = answer(bundle, 'exclude');
  const args = { jobDir: dir, config: { screeningPolicy: policy }, paperId: 'R1',
    ...response, expectedInputHash: screening.digest(bundle) };
  assert.throws(() => screening.setManualDecision({ ...args, expectedInputHash: 'stale' }), e => e.reason === 'screening_input_changed');
  assert.throws(() => screening.setManualDecision({ ...args, expectedPolicyHash: 'stale' }), e => e.reason === 'screening_policy_changed');
  assert.throws(() => screening.setManualDecision({ ...args, evidence: [{ source_id: 'R1', field: 'abstract', quote: 'Invented!' }] }), e => e.reason === 'screening_manual_invalid');
  assert.equal(fs.existsSync(path.join(dir, 'screening/status.json')), false);
  job(dir, [row('R1', { abstract: '' })]);
  args.expectedInputHash = screening.digest(screening.loadInputs(dir)[0]);
  assert.throws(() => screening.setManualDecision(args), e => e.reason === 'screening_manual_invalid');
  assert.equal(fs.existsSync(path.join(dir, 'screening/status.json')), false);
}));

test('invalid configured policy is never legacy and malformed saved state remains unmodified', () => isolated(async dir => {
  job(dir);
  for (const invalid of [{}, [], '', false]) {
    await assert.rejects(screening.runScreeningStage({ jobDir: dir, config: { screeningPolicy: invalid } }), e => e.reason === 'screening_policy_missing');
  }
  const file = path.join(dir, 'screening/status.json');
  write(file, { version: screening.VERSION, records: [] });
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(screening.runScreeningStage({ jobDir: dir, config: { screeningPolicy: policy }, bridge: mockBridge() }), e => e.reason === 'screening_state_invalid');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
}));

test('human fulltext selection can resolve missing abstracts but cannot automatically enable extraction', () => isolated(async dir => {
  job(dir, [row('R1', { abstract: '' })]);
  const sourceReference = savedPdf(dir), bundle = screening.loadInputs(dir)[0];
  write(path.join(dir, 'run_config.json'), { screeningPolicy: policy });
  const result = screening.setManualDecision({ jobDir: dir, paperId: 'R1', decision: 'include',
    reason: 'Researcher read the saved PDF methods and selects a fulltext candidate.',
    fulltextReviewed: true, sourceReference, expectedInputHash: screening.digest(bundle) });
  assert.equal(result.record.reviewer.type, 'human');
  assert.equal(result.record.reviewStage, 'fulltext_selection');
  assert.equal(result.record.extraction_allowed, false);
  assert.equal(result.record.requires_fulltext_eligibility, true);
  const bridge = mockBridge();
  const resumed = await screening.runScreeningStage({ root, bridge, jobDir: dir });
  assert.equal(resumed.reused, 1); assert.equal(bridge.calls.length, 0);
  const script = 'import json,sys;sys.path.insert(0,sys.argv[1]);from literature_screening import gate_targets;p=json.load(open(sys.argv[2]+"/run_config.json",encoding="utf-8"))["screeningPolicy"];print(json.dumps(gate_targets(sys.argv[2],[{"paper_id":"R1"}],p)))';
  const python = process.env.WORKBENCH_PYTHON || (fs.existsSync(path.join(root, '.venv/Scripts/python.exe')) ? path.join(root, '.venv/Scripts/python.exe') : 'python');
  const checked = spawnSync(python, ['-X', 'utf8', '-c', script, __dirname, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(checked.status, 0, checked.stderr);
  const gate = JSON.parse(checked.stdout);
  assert.deepEqual(gate.unscreened, []); assert.equal(gate.targets[0].screening_decision, 'include');
  assert.equal(gate.targets[0].extraction_allowed, false); assert.equal(gate.targets[0].requires_fulltext_eligibility, true);
  fs.appendFileSync(path.join(dir, sourceReference.path), 'changed');
  assert.equal(screening.validStored(result.record, bundle, policy, dir), null);
}));

test('fulltext manual selection rejects missing, foreign and traversal file references', () => isolated(async dir => {
  job(dir); const sourceReference = savedPdf(dir, 'R2'), bundle = screening.loadInputs(dir)[0];
  const args = { jobDir: dir, config: { screeningPolicy: policy }, paperId: 'R1', decision: 'include',
    reason: 'Read the full text.', fulltextReviewed: true, expectedInputHash: screening.digest(bundle) };
  for (const reference of [sourceReference, { path: '../R1.pdf', pages: '1' }, { path: 'missing.pdf', pages: '1' }, { path: sourceReference.path, pages: '' }]) {
    assert.throws(() => screening.setManualDecision({ ...args, sourceReference: reference }), e => e.reason === 'screening_manual_invalid');
  }
  assert.equal(fs.existsSync(path.join(dir, 'screening/status.json')), false);
}));

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log('OK ' + name); }
  console.log(`LITERATURE_SCREENING_TESTS_PASS ${tests.length}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
