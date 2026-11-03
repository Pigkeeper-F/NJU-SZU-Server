#!/usr/bin/env node
'use strict';
// Actual routes, confirmed config builder, connector and screening engine.
// Only temporary files, an in-memory model and inert acquisition stages run.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createHash } = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const { LiteratureAuxiliary } = require('./literature-auxiliary');
const confirmed = require('./literature-confirmed-plan');
const screening = require('./literature-screening');
const { normalizeConfig } = require('./literature-config');
const REPO = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const from = source.indexOf('async function handleLiterature('), to = source.indexOf('\nfunction normalizeMessages(', from);
assert.ok(from >= 0 && to > from, 'The production route handler must be available');
const sha = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(dir, name, data) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); return file;
}
function deferred() { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; }
function rows() {
  return ['R1', 'R2', 'R3'].map(id => ({ candidate_id: id, source_key: 'scopus', title: `${id} Heat stress and broiler growth`,
    abstract: id === 'R2' ? '' : 'Broilers were allocated to thermoneutral and heat stress groups. Weight gain was measured.',
    keywords: ['heat stress', 'growth'] }));
}
function candidates(job) { write(job.dir, 'candidates.json', { records: rows(), count: 3, discovery_complete: true, batches: [{ source_key: 'scopus', status: 'ok' }] }); }
function mockBridge(options = {}) {
  const states = new Map(), calls = [], second = deferred(); let cancelled = 0;
  return { calls, second: second.promise, get cancelled() { return cancelled; },
    createSession() { return { id: 'offline-session' }; },
    async run(session, messages, instructions, execute, model, moduleType) {
      assert.equal(execute, false); assert.equal(moduleType, 'literature-mining');
      const bundle = JSON.parse(messages[0].content.split('【本篇可用原始证据；全文尚未下载】\n')[1].split('\n只判断本篇')[0]);
      const id = 'offline-' + (calls.length + 1); calls.push(bundle.paper_id);
      const decision = bundle.paper_id === 'R3' ? 'exclude' : 'include';
      const reply = { paper_id: bundle.paper_id, decision, reason: 'Offline cited eligibility decision.', exclusionRule: decision === 'exclude' ? 'Offline exclusion rule' : '',
        evidence: [{ source_id: bundle.documents[0].source_id, field: 'title', quote: bundle.documents[0].title, criterion: '对象与环境' }], uncertainties: [] };
      states.set(id, { id, status: options.waitSecond && calls.length === 2 ? 'running' : 'completed',
        text: options.failSecond && calls.length === 2 ? 'invalid model output' : JSON.stringify(reply), model: 'offline-fixture' });
      if (calls.length === 2) second.resolve(); return { id };
    }, snapshot(id) { return states.get(id); }, async cancel() { cancelled++; }
  };
}
function harness(root, options = {}) {
  const calls = [], runs = [], bridge = options.bridge || mockBridge();
  const connector = new LiteratureConnector(root, {
    prepare: async () => { calls.push('prepare'); if (options.prepareFailure) throw new Error('offline preparation failure'); return 'inert-python'; },
    search: async (job, python, emit) => { calls.push('search'); candidates(job); emit({ type: 'result', count: 3, files: ['candidates.json'], discovery_complete: true }); },
    openSource: async () => { calls.push('browser'); throw new Error('No browser may open in this test'); },
    openFulltext: async () => { calls.push('browser'); throw new Error('No browser may open in this test'); },
    screen: options.noScreen ? null : async (job, python, emit, signal) => {
      calls.push('screen');
      return screening.runScreeningStage({ root, bridge, jobDir: job.dir, config: job.config, onEvent: emit, signal, pollMs: 1, timeoutMs: 10000 });
    }
  });
  connector.runStage = async (script, args, job, emit) => {
    if (script === 'literature_dedupe.py') {
      calls.push('dedupe');
      const records = read(path.join(job.dir, 'candidates.json')).records;
      write(job.dir, 'dedupe/dedupe.json', { version: 1, candidate_file_sha256: sha(fs.readFileSync(path.join(job.dir, 'candidates.json'))),
        groups: records.map(record => ({ canonical_id: record.candidate_id, records: [record] })) });
      emit({ type: 'result', count: 3, files: ['dedupe/dedupe.json'] }); return;
    }
    assert.equal(script, 'literature_fulltext.py', 'A tested run must stop before extraction'); calls.push('fulltext');
    assert.equal(job.status, 'running'); assert.equal(job.stages.fulltext, 'running', 'A screening result must not complete fulltext');
    const state = read(path.join(job.dir, 'screening/status.json'));
    assert.deepEqual(state.counts, { include: 1, pending: 1, exclude: 1 }, 'Acquisition is only entered after persisted valid screening');
    if (options.fulltextGate) await options.fulltextGate.promise;
    if (options.noFulltextResult) return;
    // This is a status fixture, not a download. No HTTP/browser operation occurs.
    write(job.dir, 'fulltext/status.json', { items: [] });
    emit({ type: 'result', count: 0, counts: { fetched_pdf: 0 }, files: ['fulltext/status.json'] });
  };
  const run = connector.run.bind(connector);
  connector.run = (...args) => { const promise = run(...args); runs.push(promise); return promise; };
  const auxiliary = new LiteratureAuxiliary(root, connector);
  const context = vm.createContext({ ROOT: root, fs, path, scholar: connector, literatureAuxiliary: auxiliary,
    require: name => { assert.ok(name.startsWith('./tools/'), 'Only known local modules are routed'); return require(path.join(REPO, name)); },
    readBody: async (req, limit) => { if (Buffer.byteLength(req.body) > limit) throw new Error('请求体过大'); return req.body; },
    sendJson(res, code, body) { res.code = code; res.body = JSON.parse(JSON.stringify(body)); }, console });
  vm.runInContext(source.slice(from, to), context, { filename: 'confirmed-integration-production-routes.js' });
  const route = async (method, url, body = {}) => {
    const res = {}; await context.handleLiterature({ method, body: JSON.stringify(body) }, res, new URL(url, 'http://offline.invalid')); return res;
  };
  return { connector, calls, runs, bridge, auxiliary, route,
    async prepare(presetId = 'SCOPUS-PRODUCTION') {
      const response = await route('POST', '/api/literature/confirmed-plan/prepare', { presetId });
      assert.equal(response.code, 201, JSON.stringify(response.body)); return connector.jobs.get(response.body.job.id);
    }, async finish() { for (const promise of runs) await promise; } };
}
async function isolated(fn) {
  const root = fs.mkdtempSync(path.join(REPO, '.test-literature-confirmed-integration-'));
  try {
    fs.mkdirSync(path.join(root, 'config')); fs.copyFileSync(path.join(REPO, 'config/confirmed-climate-research.json'), path.join(root, 'config/confirmed-climate-research.json'));
    await fn(root);
  } finally {
    const relative = path.relative(REPO, root);
    assert.ok(relative.startsWith('.test-literature-confirmed-integration-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('all ten confirmed presets bind exact policy/source/date and the full Scholar catalog', () => isolated(async root => {
  const bytes = fs.readFileSync(path.join(root, 'config/confirmed-climate-research.json')), catalog = confirmed.catalog(root);
  assert.equal(catalog.entries.length, 10); assert.equal(new Set(catalog.entries.map(e => e.id)).size, 10); assert.equal(catalog.bundleHash, sha(bytes));
  const expectedSources = ['cnki', 'wanfang', 'web-of-science', 'scopus', 'google-scholar']; let topics = 0;
  for (const source of expectedSources) assert.deepEqual(catalog.entries.filter(e => e.source === source).map(e => e.line).sort(), ['emission', 'production']);
  for (const entry of catalog.entries) {
    const { config, basis } = confirmed.buildConfig(root, entry.id, new Date('2026-10-31T16:30:00Z'));
    assert.deepEqual(normalizeConfig(config, { executable: true }), config);
    assert.deepEqual(config.sources, [entry.source]); assert.equal(config.sourceQueries[entry.source], config.query);
    assert.equal(config.screeningPolicy.id, entry.screeningPolicy.id); assert.equal(config.screeningPolicy.line, entry.line); assert.equal(config.screeningPolicy.text, entry.screeningPolicy.text);
    assert.equal(config.researchPlan.boundDate, '2026-11-01', 'Configuration date uses Shanghai time');
    assert.equal(config.researchPlan.bundleHash, catalog.bundleHash); assert.equal(basis.historicalCount, entry.reportedCount);
    assert.equal(config.searchMode, 'formal'); assert.equal(config.stopMode, 'end'); assert.equal(config.perSourceLimit, null); assert.equal(config.fulltext.maxPapers, 0);
    if (entry.source === 'web-of-science') assert.match(config.query, /DOP=2000-01-01\/2026-11-01/);
    if (entry.source === 'scopus') assert.match(config.query, /PUBYEAR BEF 2027/);
    if (entry.source === 'google-scholar') {
      assert.equal(config.scholarPlan.version, 2); assert.equal(config.scholarPlan.yearSpan, 0, 'Start with whole period, not an old five-year default');
      assert.equal(config.scholarPlan.topics.length, entry.queries.length); topics += config.scholarPlan.topics.length;
      assert.deepEqual(config.scholarPlan.topics.map(q => q.query), entry.queries.map(q => q.query));
    } else assert.equal(config.scholarPlan, undefined);
  }
  assert.equal(topics, 305); assert.throws(() => confirmed.buildConfig(root, 'missing'), /请选择/);
  assert.equal(sha(fs.readFileSync(path.join(root, 'config/confirmed-climate-research.json'))), sha(bytes), 'Building cannot edit the approved bundle');
}));

test('five-source catalog rejects PMC and other non-five discovery sources', () => isolated(async root => {
  const file = path.join(root, 'config/confirmed-climate-research.json');
  const data = read(file);
  data.entries[0].source = 'pmc';
  write(root, 'config/confirmed-climate-research.json', data);
  assert.throws(() => confirmed.catalog(root), /非五库检索来源/);
}));

test('production prepare route creates ten paused tasks and never executes environment, search, browser or download', () => isolated(async root => {
  const h = harness(root); const catalog = await h.route('GET', '/api/literature/confirmed-plan'); assert.equal(catalog.code, 200);
  for (const entry of catalog.body.entries) {
    const job = await h.prepare(entry.id); assert.equal(job.status, 'needs_attention'); assert.equal(job.stage, 'prepared'); assert.equal(job.resumeStage, 'discover');
    assert.ok(STAGES.every(stage => job.stages[stage] === 'pending')); assert.equal(job.child, null); assert.equal(job.activeStage, null);
    assert.equal(read(path.join(job.dir, 'research-basis.json')).presetId, entry.id);
    assert.deepEqual(read(path.join(job.dir, 'run_config.json')), job.config);
    assert.equal(fs.existsSync(path.join(job.dir, 'candidates.json')), false); assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false);
  }
  assert.equal(h.connector.jobs.size, 10); assert.deepEqual(h.calls, []); assert.equal(h.runs.length, 0);
  assert.equal((await h.route('POST', '/api/literature/confirmed-plan/prepare', { presetId: 'missing' })).code, 400);
  assert.equal(h.connector.jobs.size, 10, 'Invalid preset does not leave an orphan task');
  const first = [...h.connector.jobs.values()][0]; h.connector.cancel(first.id); await h.finish(); assert.deepEqual(h.calls, []);
}));

test('explicit continuation executes dedupe then actual screening before acquisition; screening result is not completion', () => isolated(async root => {
  const gate = deferred(), h = harness(root, { fulltextGate: gate }), job = await h.prepare();
  h.connector.advance(job.id, { until: 'fulltext' });
  for (let i = 0; i < 100 && !h.calls.includes('fulltext'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ['prepare', 'search', 'dedupe', 'screen', 'fulltext']);
  assert.equal(job.status, 'running'); assert.equal(job.stages.fulltext, 'running'); assert.deepEqual(job.counters.screening, { include: 1, pending: 1, exclude: 1 });
  assert.equal(job.stages.extract, 'pending'); assert.equal(fs.existsSync(path.join(job.dir, 'fulltext/status.json')), false);
  const view = await h.route('GET', '/api/literature/screening?id=' + job.id);
  assert.equal(view.code, 200); assert.deepEqual(view.body.counts, { include: 1, pending: 1, exclude: 1, unscreened: 0 });
  assert.ok(view.body.records.every(r => r.inputHash && r.policyHash && !r.pdfPath));
  gate.resolve(); await h.finish(); assert.equal(job.status, 'completed'); assert.equal(job.stages.fulltext, 'done'); assert.equal(job.stages.extract, 'pending');
}));

test('a successful screening result cannot hide a missing fulltext result', () => isolated(async root => {
  const h = harness(root, { noFulltextResult: true }), job = await h.prepare(); h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
  assert.equal(job.status, 'failed'); assert.equal(job.stages.fulltext, 'failed'); assert.equal(job.resumeStage, 'fulltext');
  assert.match(job.error, /阶段脚本未返回结果/); assert.equal(job.stages.extract, 'pending');
}));

test('missing screening service pauses before the fulltext process or browser can start', () => isolated(async root => {
  const h = harness(root, { noScreen: true }), job = await h.prepare(); h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
  assert.equal(job.status, 'needs_attention'); assert.equal(job.resumeStage, 'fulltext'); assert.equal(job.attention.reason, 'screening_model_unavailable');
  assert.equal(h.calls.includes('fulltext'), false); assert.equal(h.calls.includes('browser'), false); assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false);
}));

test('a screening hook without explicit ok true cannot start acquisition even after a result event', () => isolated(async root => {
  const h = harness(root);
  for (const result of [undefined, null, false, {}, { ok: false }, { ok: 'true' }]) {
    const job = await h.prepare();
    h.connector.screen = async (j, python, emit) => {
      emit({ type: 'result', stage: 'screening', counts: { include: 3, pending: 0, exclude: 0 }, message: 'Inert incomplete adapter' });
      return result;
    };
    h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
    assert.equal(job.status, 'needs_attention'); assert.equal(job.attention.reason, 'screening_output_invalid');
    assert.equal(job.stages.fulltext, 'pending'); assert.equal(job.resumeStage, 'fulltext');
    assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false);
  }
  assert.equal(h.calls.includes('fulltext'), false); assert.equal(h.calls.includes('browser'), false);
}));

test('invalid model output preserves the first checkpoint, blocks acquisition and resumes from unscreened papers', () => isolated(async root => {
  const h = harness(root, { bridge: mockBridge({ failSecond: true }) }), job = await h.prepare();
  h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
  assert.equal(job.status, 'needs_attention'); assert.equal(job.attention.reason, 'screening_output_invalid'); assert.equal(job.resumeStage, 'fulltext');
  assert.equal(h.calls.includes('fulltext'), false); assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false);
  const state = read(path.join(job.dir, 'screening/status.json')); assert.equal(state.records.R1.decision, 'include'); assert.equal(state.records.R2.decision, 'pending'); assert.equal(state.records.R3, undefined);
  const bridge = mockBridge(); h.connector.screen = (j, python, onEvent, signal) => screening.runScreeningStage({ root, bridge, jobDir: j.dir, config: j.config, onEvent, signal, pollMs: 1 });
  h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
  assert.deepEqual(bridge.calls, ['R3']); assert.equal(job.status, 'completed'); assert.equal(h.calls.filter(c => c === 'search').length, 1);
}));

test('cancelling a running screen aborts its model, keeps saved decisions, and starts no acquisition', () => isolated(async root => {
  const bridge = mockBridge({ waitSecond: true }), h = harness(root, { bridge }), job = await h.prepare();
  h.connector.advance(job.id, { until: 'fulltext' }); await bridge.second;
  const controller = job.screeningAbort; assert.equal(controller.signal.aborted, false); h.connector.cancel(job.id); assert.equal(controller.signal.aborted, true);
  await h.finish(); assert.equal(job.status, 'cancelled'); assert.equal(bridge.cancelled, 1); assert.equal(job.screeningAbort, null);
  assert.deepEqual(bridge.calls, ['R1', 'R3']); assert.equal(h.calls.includes('fulltext'), false); assert.equal(h.calls.includes('browser'), false);
  const state = read(path.join(job.dir, 'screening/status.json')); assert.equal(state.records.R1.decision, 'include'); assert.equal(state.records.R2.decision, 'pending'); assert.equal(state.records.R3, undefined);
  assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false); assert.equal(job.stages.extract, 'pending');
}));

test('explicit confirmed resume survives real screen cancellation and keeps the normal pause-on-unavailable policy', () => isolated(async root => {
  const bridge = mockBridge({ waitSecond: true }), h = harness(root, { bridge }), job = await h.prepare();
  const configHash = sha(fs.readFileSync(path.join(job.dir, 'run_config.json')));
  h.connector.advance(job.id, { until: 'fulltext' }); await bridge.second;
  h.connector.cancel(job.id);
  assert.throws(() => h.connector.advance(job.id, { until: 'fulltext', resumeConfirmed: true }), /停止|正在保存/,
    'The old worker must settle before a new generation can take over');
  await h.finish();
  assert.equal(job.activeStage, null, 'Cancelled worker must release its active stage after settling');
  assert.equal(job.resumeStage, 'fulltext', 'Cancellation must preserve the active checkpoint');
  const withoutFlag = await h.route('POST', '/api/literature/advance', { id: job.id, until: 'fulltext' });
  assert.equal(withoutFlag.code, 400, 'Cancellation is never resumed implicitly');
  const resumedBridge = mockBridge(); h.connector.screen = (j, python, onEvent, signal) => screening.runScreeningStage({ root, bridge: resumedBridge,
    jobDir: j.dir, config: j.config, onEvent, signal, pollMs: 1 });
  const response = await h.route('POST', '/api/literature/advance', { id: job.id, until: 'fulltext', resumeConfirmed: true });
  assert.equal(response.code, 200, JSON.stringify(response.body)); await h.finish();
  assert.equal(job.status, 'completed'); assert.deepEqual(resumedBridge.calls, ['R3'], 'Already persisted model and missing-abstract decisions remain reusable');
  assert.equal(h.connector.snapshot(job.id).fulltextFailurePolicy, 'pause', 'Explicit resume must not silently enable skipUnavailable');
  assert.equal(h.calls.filter(c => c === 'search').length, 1); assert.equal(h.calls.filter(c => c === 'fulltext').length, 1);
  assert.equal(sha(fs.readFileSync(path.join(job.dir, 'run_config.json'))), configHash, 'Resume cannot edit frozen configuration');
}));

test('advance HTTP handler forwards only explicit boolean resumeConfirmed for a prepared cancelled task', () => isolated(async root => {
  const h = harness(root), job = await h.prepare(); h.connector.cancel(job.id);
  assert.equal(job.activeStage, null); assert.equal(job.resumeStage, 'discover');
  for (const value of [undefined, false, 'true']) {
    const denied = await h.route('POST', '/api/literature/advance', { id: job.id, until: 'discover', ...(value === undefined ? {} : { resumeConfirmed: value }) });
    assert.equal(denied.code, 400); assert.deepEqual(h.calls, []);
  }
  const response = await h.route('POST', '/api/literature/advance', { id: job.id, until: 'discover', resumeConfirmed: true });
  assert.equal(response.code, 200, JSON.stringify(response.body)); await h.finish();
  assert.equal(job.status, 'completed'); assert.deepEqual(h.calls, ['prepare', 'search']); assert.equal(job.stages.fulltext, 'pending');
}));

test('resumeConfirmed cannot revive legacy tasks or tasks with missing binding evidence', () => isolated(async root => {
  const h = harness(root), { config } = confirmed.buildConfig(root, 'SCOPUS-PRODUCTION');
  delete config.researchPlan; delete config.screeningPolicy;
  const legacy = h.connector.start(config, false, 'discover'); h.connector.cancel(legacy.id); await h.finish();
  const callsBefore = h.calls.length;
  const denied = await h.route('POST', '/api/literature/advance', { id: legacy.id, until: 'discover', resumeConfirmed: true });
  assert.equal(denied.code, 400); assert.equal(h.calls.length, callsBefore);
  const unbound = await h.prepare(); h.connector.cancel(unbound.id);
  fs.renameSync(path.join(unbound.dir, 'research-basis.json'), path.join(unbound.dir, 'fixture-unbound-basis.json'));
  assert.throws(() => h.connector.advance(unbound.id, { until: 'discover', resumeConfirmed: true }), /停止/);
  assert.equal(h.calls.length, callsBefore); assert.equal(unbound.status, 'cancelled');
}));

test('environment preparation failure never invokes a source, model or downloader', () => isolated(async root => {
  const h = harness(root, { prepareFailure: true }), job = await h.prepare(); h.connector.advance(job.id, { until: 'fulltext' }); await h.finish();
  assert.equal(job.status, 'needs_attention'); assert.deepEqual(h.calls, ['prepare']); assert.equal(h.bridge.calls.length, 0);
  assert.equal(fs.existsSync(path.join(job.dir, 'candidates.json')), false); assert.equal(fs.existsSync(path.join(job.dir, 'fulltext')), false);
}));

test('manual route requires the matching saved PDF and versions, returns 409 for stale evidence, and starts no execution', () => isolated(async root => {
  const h = harness(root), job = await h.prepare(); candidates(job);
  let view = await h.route('GET', '/api/literature/screening?id=' + job.id);
  assert.equal(view.body.counts.unscreened, 3); const first = view.body.records[0];
  const payload = { id: job.id, paperId: 'R1', decision: 'include', reason: 'Read original groups and result table.',
    expectedInputHash: first.inputHash, expectedPolicyHash: first.policyHash, fulltextReviewed: true,
    sourceReference: { path: 'fulltext/files/R1.pdf', pages: '2-3, table 1' } };
  assert.equal((await h.route('POST', '/api/literature/screening/manual', payload)).code, 400);
  const pdf = write(job.dir, payload.sourceReference.path, '%PDF-1.4\nOffline fixture for provenance validation\n%%EOF');
  write(job.dir, 'fulltext/status.json', { items: [{ paper_id: 'R1', status: 'fetched_pdf', kind: 'pdf', path: payload.sourceReference.path, size: fs.statSync(pdf).size }] });
  assert.equal((await h.route('POST', '/api/literature/screening/manual', { ...payload, expectedInputHash: 'stale' })).code, 409);
  assert.equal((await h.route('POST', '/api/literature/screening/manual', { ...payload, expectedPolicyHash: 'stale' })).code, 409);
  const saved = await h.route('POST', '/api/literature/screening/manual', payload); assert.equal(saved.code, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.record.extraction_allowed, false); assert.equal(saved.body.record.requires_fulltext_eligibility, true);
  view = await h.route('GET', '/api/literature/screening?id=' + job.id); assert.equal(view.body.records[0].decision, 'include'); assert.equal(view.body.records[0].pdfPath, payload.sourceReference.path);
  assert.deepEqual(h.calls, []); assert.equal(h.runs.length, 0); assert.equal(h.auxiliary.busy, false);
  fs.appendFileSync(pdf, '\nchanged original');
  view = await h.route('GET', '/api/literature/screening?id=' + job.id); assert.equal(view.body.records[0].decision, 'unscreened', 'Changed PDF invalidates fulltext decision');
  fs.mkdirSync(path.join(job.dir, 'extraction'));
  assert.equal((await h.route('POST', '/api/literature/screening/manual', payload)).code, 409, 'Existing extraction cannot have its scientific basis rewritten');
}));

async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name); console.error(error); }
  }
  console.log(`Confirmed integration: ${tests.length - failed}/${tests.length} passed (no live service/browser/model).`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
