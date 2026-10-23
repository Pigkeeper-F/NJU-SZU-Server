'use strict';

// Isolated fixtures and real production functions only. No HTTP server,
// database request, browser, Python stage, or user task is started here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-fulltext-skip-'));
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
function fixture(connector, patch = {}) {
  const id = randomUUID(), dir = path.join(connector.base, id);
  const config = { version: 2, topic: 'isolated fixture', query: 'broiler heat stress', sources: ['pubmed'], limit: 10,
    inclusion: ['Keep scientific rules unchanged'], exclusion: ['No review articles'], targetFields: ['body weight'] };
  const record = { candidate_id: 'PMID-001', source_key: 'pubmed', title: 'Isolated study', doi: '10.fixture/example' };
  const saved = { id, status: 'needs_attention', stage: 'verification', resumeStage: 'fulltext', until: 'fulltext',
    config, count: 1, files: ['run_config.json', 'candidates.json', 'fulltext/status.json'], counters: {}, events: [], error: null,
    stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe'].includes(stage) ? 'done' : 'pending'])), ...patch };
  write(path.join(dir, 'job.json'), saved);
  write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'candidates.json'), { version: 2, count: 1, batches: [{ status: 'complete' }], records: [record] });
  write(path.join(dir, 'dedupe', 'dedupe.json'), { version: 1, groups: [{ canonical_id: record.candidate_id, title: record.title, records: [record] }] });
  write(path.join(dir, 'fulltext', 'status.json'), { version: 1, items: [
    { paper_id: record.candidate_id, title: record.title, status: 'fetched_html', path: 'fulltext/files/PMID-001.txt', evidence_level: 'fulltext_html' },
    { paper_id: 'PMID-002', status: 'needs_attention', reason: 'Attachment timed out' }
  ] });
  fs.mkdirSync(path.join(dir, 'fulltext', 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fulltext', 'files', 'PMID-001.txt'), 'Saved fixture body; never overwrite.');
  return { id, dir, saved };
}
function protectedBytes(dir) {
  return Object.fromEntries(['run_config.json', 'candidates.json', 'dedupe/dedupe.json', 'fulltext/status.json', 'fulltext/files/PMID-001.txt']
    .map(relative => [relative, fs.readFileSync(path.join(dir, relative))]));
}
function assertProtected(dir, before) {
  for (const [relative, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(dir, relative)), bytes, relative + ' changed');
  for (const relative of ['extraction', 'validation', 'export']) assert.equal(fs.existsSync(path.join(dir, relative)), false, 'No downstream ' + relative);
}
async function finish(connector, id) {
  for (let i = 0; i < 100; i++) { const state = connector.snapshot(id); if (state.status !== 'running') return state; await tick(); }
  throw new Error('Isolated fixture did not finish');
}
function connector(name = randomUUID()) {
  const instance = new LiteratureConnector(path.join(temporary, name), { prepare: async () => 'never-executed-python' });
  const calls = [];
  instance.runStage = async (script, args, job, emit) => {
    calls.push({ script, args: [...args], jobId: job.id });
    assert.equal(script, 'literature_fulltext.py', 'Skip action must not execute another stage');
    emit({ type: 'result', stage: 'fulltext', count: 1,
      counts: { fetched_pdf: 0, fetched_html: 1, unavailable: 1, abstract_only: 0, needs_attention: 0, pending: 0 },
      message: 'Fulltext stage ended with missing material recorded.', files: ['fulltext/status.json'] });
  };
  return { instance, calls };
}
function productionFunction(source, name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const begin = source.indexOf(prefix + name + '(');
  assert.ok(begin >= 0, 'Missing production function ' + name);
  const end = source.indexOf('\n  }', begin);
  assert.ok(end > begin, 'Missing function end ' + name);
  return source.slice(begin, end + 4);
}
async function backendTests() {
  for (const status of ['needs_attention', 'failed', 'cancelled']) {
    const { instance, calls } = connector();
    const task = fixture(instance, { status }), before = protectedBytes(task.dir);
    assert.equal(instance.public(instance.loadPersisted(task.id)).fulltextFailurePolicy, 'pause', 'Legacy task defaults to pausing');
    const next = instance.advance(task.id, { skipUnavailable: true, until: 'fulltext' });
    assert.equal(next.fulltextFailurePolicy, 'skip'); assert.equal(next.until, 'fulltext');
    const completed = await finish(instance, task.id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.resumeStage, 'extract');
    assert.equal(completed.stages.fulltext, 'done'); assert.equal(completed.stages.extract, 'pending');
    assert.deepEqual(calls, [{ script: 'literature_fulltext.py', args: ['--resume', '--skip-unavailable'], jobId: task.id }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(task.dir, 'job.json'), 'utf8')).fulltextFailurePolicy, 'skip');
    const reloaded = new LiteratureConnector(instance.root);
    assert.equal(reloaded.loadPersisted(task.id).fulltextFailurePolicy, 'skip');
    assert.equal(reloaded.public(reloaded.jobs.get(task.id)).fulltextFailurePolicy, 'skip');
    assertProtected(task.dir, before);
  }

  // Omitted until cannot silently use the usual export default.
  const forced = connector(); const forcedTask = fixture(forced.instance);
  assert.equal(forced.instance.advance(forcedTask.id, { skipUnavailable: true }).until, 'fulltext');
  await finish(forced.instance, forcedTask.id); assert.equal(forced.calls.length, 1);

  // Legacy tasks preserve their pause behavior and can explicitly reset skip.
  for (const [patch, options] of [[{}, { until: 'fulltext' }], [{ fulltextFailurePolicy: 'skip' }, { skipUnavailable: false, until: 'fulltext' }]]) {
    const ordinary = connector(), task = fixture(ordinary.instance, patch);
    assert.equal(ordinary.instance.loadPersisted(task.id).fulltextFailurePolicy, patch.fulltextFailurePolicy || 'pause');
    ordinary.instance.advance(task.id, options); const result = await finish(ordinary.instance, task.id);
    assert.equal(result.fulltextFailurePolicy, 'pause'); assert.deepEqual(ordinary.calls[0].args, ['--resume']);
  }
  const invalidPolicy = connector(), invalidPolicyTask = fixture(invalidPolicy.instance, { fulltextFailurePolicy: 'unrecognized' });
  assert.equal(invalidPolicy.instance.loadPersisted(invalidPolicyTask.id).fulltextFailurePolicy, 'pause');
  assert.equal(invalidPolicy.instance.public({ ...invalidPolicy.instance.jobs.get(invalidPolicyTask.id), fulltextFailurePolicy: 'other' }).fulltextFailurePolicy, 'pause');

  const invalid = [
    [{}, { skipUnavailable: 'true', until: 'fulltext' }, /布尔/],
    [{}, { skipUnavailable: 1, until: 'fulltext' }, /布尔/],
    [{}, { skipUnavailable: null, until: 'fulltext' }, /布尔/],
    [{}, { skipUnavailable: true, until: 'extract' }, /只继续全文/],
    [{}, { skipUnavailable: true, until: 'export' }, /只继续全文/],
    [{}, { skipUnavailable: true, until: 'dedupe' }, /只继续全文/],
    [{}, { skipUnavailable: true, confirmations: { fields: [] } }, /不能同时修改/],
    [{}, { skipUnavailable: true, deferSource: 'pubmed' }, /不能同时修改/],
    [{ status: 'running' }, { skipUnavailable: true }, /暂停后/],
    [{ status: 'cancelled' }, { skipUnavailable: false }, /暂停后/],
    [{ status: 'cancelled' }, { until: 'fulltext' }, /任务已停止/],
    [{ status: 'completed' }, { skipUnavailable: true }, /暂停后/],
    [{ resumeStage: 'extract' }, { skipUnavailable: true }, /暂停后/],
    [{ resumeStage: 'discover' }, { skipUnavailable: true }, /暂停后/],
    [{ deletedAt: '2026-10-20T00:00:00Z' }, { skipUnavailable: true }, /已删除/],
    [{ cnkiRetryPaperId: 'CNKI-001' }, { skipUnavailable: true }, /原单篇/]
  ];
  for (const [patch, options, message] of invalid) {
    const rejected = connector(), task = fixture(rejected.instance, patch);
    const jobBytes = fs.readFileSync(path.join(task.dir, 'job.json')), before = protectedBytes(task.dir);
    assert.throws(() => rejected.instance.advance(task.id, options), message);
    assert.deepEqual(fs.readFileSync(path.join(task.dir, 'job.json')), jobBytes, 'Rejected request must not persist a policy');
    assert.equal(fs.existsSync(path.join(task.dir, 'confirmations.json')), false);
    assert.equal(rejected.calls.length, 0); assertProtected(task.dir, before);
  }
  const busy = connector(), busyTask = fixture(busy.instance);
  busy.instance.jobs.set('isolated-busy-marker', { status: 'running' });
  assert.throws(() => busy.instance.advance(busyTask.id, { skipUnavailable: true }), /正在运行/);
  assert.equal(busy.calls.length, 0);

  // A stopped task never restarts just by loading/persisting. Its explicit skip
  // action also requires the original progress and the old child to have exited.
  for (const mode of ['missing-status', 'invalid-status', 'child-exiting']) {
    const stopped = connector(), task = fixture(stopped.instance, { status: 'cancelled' });
    const loaded = stopped.instance.loadPersisted(task.id);
    assert.equal(loaded.status, 'cancelled'); assert.equal(stopped.calls.length, 0);
    if (mode === 'missing-status') fs.unlinkSync(path.join(task.dir, 'fulltext', 'status.json'));
    else if (mode === 'invalid-status') write(path.join(task.dir, 'fulltext', 'status.json'), { items: null });
    else loaded.child = { fixtureMarker: true };
    const before = fs.readFileSync(path.join(task.dir, 'job.json'));
    assert.throws(() => stopped.instance.advance(task.id, { skipUnavailable: true, until: 'fulltext' }),
      mode === 'child-exiting' ? /进程正在退出/ : /进度无法核对/);
    assert.equal(stopped.calls.length, 0); assert.equal(loaded.status, 'cancelled');
    assert.deepEqual(fs.readFileSync(path.join(task.dir, 'job.json')), before);
  }

  // A persisted policy only changes the fulltext process, not other stages.
  const stages = connector(), task = fixture(stages.instance), job = stages.instance.loadPersisted(task.id), seen = [];
  job.fulltextFailurePolicy = 'skip'; job.resumeRun = true;
  stages.instance.runStage = async (script, args) => { seen.push({ script, args }); };
  for (const stage of ['discover', 'dedupe', 'validate', 'export']) await stages.instance.runSingleStage(job, 'never-executed-python', stage, 1);
  assert.equal(seen.length, 4); assert.ok(seen.every(call => !call.args.includes('--skip-unavailable')));
}

async function routeAndUiTests() {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverSource.indexOf("    if (req.method === 'POST' && route === '/api/literature/advance') {");
  const routeEnd = serverSource.indexOf("    if (req.method === 'POST' && route === '/api/literature/continue-available')", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  for (const body of [{ id: 'fixture', until: 'fulltext', skipUnavailable: true }, { id: 'fixture', until: 'fulltext' }]) {
    const captured = [];
    const context = vm.createContext({ req: { method: 'POST' }, res: {}, route: '/api/literature/advance',
      readBody: async () => JSON.stringify(body), readLiteratureBody: async () => JSON.stringify(body),
      sendJson: (_res, status, data) => ({ status, data }),
      scholar: { advance: (id, options) => { captured.push({ id, options: copy(options), hasSkip: Object.hasOwn(options, 'skipUnavailable') }); return {}; } } });
    await vm.runInContext('(async () => {' + route + '})()', context);
    assert.equal(captured[0].id, body.id);
    assert.equal(captured[0].hasSkip, Object.hasOwn(body, 'skipUnavailable'), 'Route must not inject undefined skip policy');
    if (body.skipUnavailable === true) assert.equal(captured[0].options.skipUnavailable, true);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
  const task = { literatureJob: { id: 'existing-fixture', status: 'needs_attention', resumeStage: 'fulltext', until: 'fulltext',
    config: { sources: ['pubmed'], topic: 'unchanged' } }, literatureUntil: 'export', busy: false, literatureBusy: false };
  task.literatureConfig = copy(task.literatureJob.config);
  const configBefore = JSON.stringify(task.literatureConfig), calls = [], watched = [];
  const context = vm.createContext({ task: () => task, root: { LiteratureUI: { isBusy: () => false } }, saved: {},
    sameLiteratureConfig: (a, b) => JSON.stringify(a) === JSON.stringify(b), sameLiteratureDeferralConfig: () => false,
    LITERATURE_EXECUTABLE_SOURCES: ['pubmed'], LITERATURE_STAGE_ORDER: STAGES, literatureStageLabel: value => value,
    checkLiteratureRuntime: async () => { calls.push({ kind: 'runtime' }); }, render() {}, persist() {},
    request: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return copy(task.literatureJob); },
    applyLiteratureJob: (_mod, value) => { task.literatureJob = value; }, watchLiterature: async (...args) => { watched.push(args); } });
  vm.runInContext(productionFunction(source, 'continueLiterature') + '\nglobalThis.subject = continueLiterature;', context);
  await context.subject({ id: 'module-fixture' }, { until: 'fulltext', skipUnavailable: true });
  assert.equal(calls[0].kind, 'runtime');
  assert.deepEqual(calls[1], { url: '/api/literature/advance', body: { id: 'existing-fixture', until: 'fulltext', skipUnavailable: true } });
  assert.deepEqual(watched, [['module-fixture', 'existing-fixture']]);
  assert.equal(JSON.stringify(task.literatureConfig), configBefore); assert.equal(task.literatureBusy, false);
  assert.ok(!calls.some(call => call.url === '/api/literature/search'));

  // A stopped task can deliberately restore only its own frozen settings.
  // Merely choosing skip, or a rejected explicit restore, must not overwrite an
  // edited draft. The transport carries no config and never creates a search.
  for (const scenario of [{ explicit: true, fail: false }, { explicit: true, fail: true }, { explicit: false, fail: false }]) {
    const oldConfig = { sources: ['pubmed'], topic: 'Frozen original study', targetFields: ['old field'] };
    const draftConfig = { sources: ['cnki'], topic: 'Edited new study', targetFields: ['new field'] };
    const current = { literatureJob: { id: 'stopped-existing-fixture', status: 'cancelled', resumeStage: 'fulltext', until: 'fulltext', config: copy(oldConfig) },
      literatureConfig: copy(draftConfig), literatureUntil: 'export', busy: false, literatureBusy: false };
    const saved = { 'module-fixture': { literatureConfig: copy(draftConfig) } }, requests = [], watches = [];
    const stoppedContext = vm.createContext({ task: () => current, saved, root: { LiteratureUI: { isBusy: () => false } },
      sameLiteratureConfig: (a, b) => JSON.stringify(a) === JSON.stringify(b), sameLiteratureDeferralConfig: () => false,
      LITERATURE_EXECUTABLE_SOURCES: ['pubmed', 'cnki'], LITERATURE_STAGE_ORDER: STAGES, literatureStageLabel: value => value,
      checkLiteratureRuntime: async sources => { assert.deepEqual(copy(sources), ['pubmed']); }, render() {}, persist() {},
      request: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); if (scenario.fail) throw new Error('Fixture resume rejected'); return copy(current.literatureJob); },
      applyLiteratureJob: (_mod, value) => { current.literatureJob = value; }, watchLiterature: async (...args) => { watches.push(args); } });
    vm.runInContext(productionFunction(source, 'continueLiterature') + '\nglobalThis.subject = continueLiterature;', stoppedContext);
    await stoppedContext.subject({ id: 'module-fixture' }, { until: 'fulltext', skipUnavailable: true, ...(scenario.explicit ? { resumeStopped: true } : {}) });
    if (!scenario.explicit) {
      assert.equal(requests.length, 0); assert.match(current.literatureError, /设置已改变/);
    } else {
      assert.deepEqual(requests, [{ url: '/api/literature/advance', body: { id: 'stopped-existing-fixture', until: 'fulltext', skipUnavailable: true } }]);
      assert.equal(Object.hasOwn(requests[0].body, 'config'), false); assert.equal(Object.hasOwn(requests[0].body, 'resumeStopped'), false);
    }
    const expectedConfig = scenario.explicit && !scenario.fail ? oldConfig : draftConfig;
    assert.deepEqual(copy(current.literatureConfig), expectedConfig);
    assert.deepEqual(copy(saved['module-fixture'].literatureConfig), expectedConfig);
    assert.equal(watches.length, scenario.explicit && !scenario.fail ? 1 : 0);
    assert.equal(current.literatureBusy, false);
  }

  // Execute the real button block and its onclick, without constructing a page.
  const buttonStart = source.indexOf('      if (fulltextPaused && !job.cnkiRetryPaperId) {');
  const buttonEnd = source.indexOf('      if (fulltextPaused && job.cnkiRetryPaperId', buttonStart);
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
  const buttonCode = source.slice(buttonStart, buttonEnd);
  for (const scenario of [{ paused: true, scope: null, same: true, expected: 1 }, { paused: false, scope: null, same: true, expected: 0 },
    { paused: true, scope: 'CNKI-001', same: true, expected: 0 }, { paused: true, scope: null, same: false, expected: 1 }]) {
    const buttons = [], continuations = [];
    const buttonContext = vm.createContext({ fulltextPaused: scenario.paused, job: { cnkiRetryPaperId: scenario.scope },
      t: { literatureBusy: false, busy: false }, sameConfig: scenario.same, root: { LiteratureUI: { isBusy: () => false } }, mod: { id: 'module-fixture' },
      node: (tag, label) => ({ tag, label }), actions: { append: value => buttons.push(value) },
      continueLiterature: (_mod, options) => continuations.push(copy(options)) });
    vm.runInContext(buttonCode, buttonContext); assert.equal(buttons.length, scenario.expected);
    if (buttons.length) {
      assert.equal(buttons[0].label, '跳过无法获取的文献，继续'); assert.equal(buttons[0].disabled, !scenario.same);
      if (scenario.same) { buttons[0].onclick(); assert.deepEqual(continuations, [{ until: 'fulltext', skipUnavailable: true }]); }
    }
  }

  const stoppedStart = source.indexOf("    if (job?.status === 'cancelled' && job.resumeStage === 'fulltext' && !job.cnkiRetryPaperId) {");
  const stoppedEnd = source.indexOf('    if (job?.id) {', stoppedStart);
  assert.ok(stoppedStart >= 0 && stoppedEnd > stoppedStart);
  for (const scenario of [{ status: 'cancelled', stage: 'fulltext', scope: null, expected: 1 },
    { status: 'needs_attention', stage: 'fulltext', scope: null, expected: 0 },
    { status: 'cancelled', stage: 'discover', scope: null, expected: 0 },
    { status: 'cancelled', stage: 'fulltext', scope: 'CNKI-001', expected: 0 }]) {
    const buttons = [], continuations = [];
    const buttonContext = vm.createContext({ job: { status: scenario.status, resumeStage: scenario.stage, cnkiRetryPaperId: scenario.scope },
      t: { literatureBusy: false, busy: false }, root: { LiteratureUI: { isBusy: () => false } }, mod: { id: 'module-fixture' },
      node: (tag, label) => ({ tag, label }), row: { append: value => buttons.push(value) },
      continueLiterature: (_mod, options) => continuations.push(copy(options)) });
    vm.runInContext(source.slice(stoppedStart, stoppedEnd), buttonContext);
    assert.equal(buttons.length, scenario.expected); assert.equal(continuations.length, 0, 'Rendering a stopped task must never resume it');
    if (buttons.length) {
      assert.equal(buttons[0].label, '按原任务继续（跳过失败项）');
      buttons[0].onclick(); assert.deepEqual(continuations, [{ until: 'fulltext', skipUnavailable: true, resumeStopped: true }]);
    }
  }
}

async function main() {
  await backendTests(); await routeAndUiTests();
  console.log('LITERATURE_FULLTEXT_SKIP_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = path.resolve(temporary);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('literature-fulltext-skip-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(target, { recursive: true, force: true });
});
