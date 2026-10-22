'use strict';

// Isolated fixtures: no real jobs, browser, account or database requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-cnki-single-'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value) + '\n'); };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(connector, patch = {}) {
  const id = randomUUID(), dir = path.join(connector.base, id);
  const config = { topic: 'fixture', query: 'original query', sources: ['cnki', 'pubmed'], limit: 10 };
  const records = ['CNKI-001', 'CNKI-002', 'PMID-003'].map((candidate_id, index) => ({ candidate_id,
    source_key: index === 2 ? 'pubmed' : 'cnki', title: '原题名' + index, result_url: 'https://example.org/' + index }));
  const saved = { id, config, status: 'needs_attention', stage: 'fulltext_review', resumeStage: 'fulltext', activeStage: null,
    until: 'export', count: 0, files: ['run_config.json', 'candidates.json', 'dedupe/dedupe.json', 'fulltext/status.json'], events: [], counters: {},
    stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe'].includes(stage) ? 'done' : 'pending'])), ...patch };
  write(path.join(dir, 'job.json'), saved); write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'candidates.json'), { records });
  write(path.join(dir, 'dedupe', 'dedupe.json'), { groups: records.map(record => ({ canonical_id: record.candidate_id, title: record.title, records: [{ ...record }] })) });
  write(path.join(dir, 'fulltext', 'status.json'), { items: records.map(record => ({ paper_id: record.candidate_id, title: record.title,
    status: 'unavailable', reason: 'https://private.example?token=should-not-leak' })) });
  return { id, dir, records };
}
async function finish(connector, id) {
  for (let attempt = 0; attempt < 100; attempt++) { if (connector.snapshot(id).status !== 'running') return connector.snapshot(id); await turn(); }
  throw new Error('single retry fixture did not finish');
}
const originalFiles = target => ['run_config.json', 'candidates.json', 'dedupe/dedupe.json'].map(name => fs.readFileSync(path.join(target.dir, name)));
async function main() {
  let searched = 0, called = 0;
  const connector = new LiteratureConnector(root, { prepare: async () => 'fixture-python', search: async () => { searched++; } });
  connector.runStage = async (script, args, job, event) => {
    called++; assert.equal(script, 'literature_fulltext.py');
    assert.deepEqual(args, ['--resume', '--only', 'CNKI-001', '--retry-unavailable', '--limit', '1']);
    const file = path.join(job.dir, 'fulltext', 'status.json'), status = JSON.parse(fs.readFileSync(file));
    status.items[0].status = 'fetched_pdf'; write(file, status);
    event({ type: 'result', stage: 'fulltext', count: 1, counts: { fetched_pdf: 1, unavailable: 2 }, files: ['fulltext/status.json'] });
  };
  const target = fixture(connector), before = originalFiles(target);
  const snapshot = connector.snapshot(target.id);
  assert.deepEqual(snapshot.cnkiRetryItems.map(item => item.id), ['CNKI-001', 'CNKI-002']);
  assert.ok(!JSON.stringify(snapshot.cnkiRetryItems).includes('token='));
  assert.equal(connector.retryCnki(target.id, 'CNKI-001').status, 'running');
  assert.throws(() => connector.retryCnki(target.id, 'CNKI-001'), /正在运行/);
  const result = await finish(connector, target.id);
  assert.equal(called, 1); assert.equal(searched, 0); assert.equal(result.until, 'fulltext');
  assert.equal(result.status, 'needs_attention'); assert.equal(result.stage, 'fulltext_ready');
  assert.equal(result.resumeStage, 'fulltext'); assert.equal(result.stages.fulltext, 'pending');
  assert.equal(result.activeStage, null); assert.equal(result.cnkiRetryPaperId, null);
  assert.match(result.message, /仅执行了指定的这一篇/);
  assert.deepEqual(result.cnkiRetryItems.map(item => item.id), ['CNKI-002']);
  assert.deepEqual(originalFiles(target), before);
  assert.throws(() => connector.retryCnki(target.id, 'CNKI-001'), /只能重试/);
  for (const invalid of ['../bad', 'CNKI-001,CNKI-002', '--all', 'x\n--limit=13']) {
    assert.throws(() => connector.retryCnki(target.id, invalid), /无效/);
  }
  assert.throws(() => connector.retryCnki(target.id, 'PMID-003'), /只能重试/);
  for (const status of ['cancelled', 'queued']) {
    const rejected = fixture(connector, { status });
    assert.equal(connector.snapshot(rejected.id).cnkiRetryItems.length, 0);
    assert.throws(() => connector.retryCnki(rejected.id, 'CNKI-001'), /只能重试|先复核/);
  }
  for (const downstream of ['extraction', 'validation', 'export']) {
    const rejected = fixture(connector); write(path.join(rejected.dir, downstream, 'already-saved.json'), {});
    assert.equal(connector.snapshot(rejected.id).cnkiRetryItems.length, 0);
    assert.throws(() => connector.retryCnki(rejected.id, 'CNKI-001'), /只能重试/);
  }
  const deleted = fixture(connector, { deletedAt: '2026-10-20T00:00:00Z' });
  assert.throws(() => connector.retryCnki(deleted.id, 'CNKI-001'), /只能重试/);
  const forged = fixture(connector);
  const forgedGroups = JSON.parse(fs.readFileSync(path.join(forged.dir, 'dedupe', 'dedupe.json')));
  forgedGroups.groups[0].records[0].title = '另一篇相似文献'; write(path.join(forged.dir, 'dedupe', 'dedupe.json'), forgedGroups);
  assert.throws(() => connector.retryCnki(forged.id, 'CNKI-001'), /只能重试/);
  const duplicated = fixture(connector);
  const duplicatedGroups = JSON.parse(fs.readFileSync(path.join(duplicated.dir, 'dedupe', 'dedupe.json')));
  duplicatedGroups.groups.push(duplicatedGroups.groups[0]); write(path.join(duplicated.dir, 'dedupe', 'dedupe.json'), duplicatedGroups);
  assert.throws(() => connector.retryCnki(duplicated.id, 'CNKI-001'), /只能重试/);

  // Real attention preserves the single-paper scope across restart. Generic
  // advance cannot silently expand it into a batch after manual verification.
  connector.runStage = async (_script, _args, job, event) => {
    event({ type: 'attention', stage: 'verification', reason: 'verification', paper_id: 'CNKI-001', message: '请人工完成验证码' });
  };
  const paused = fixture(connector); connector.retryCnki(paused.id, 'CNKI-001');
  const attention = await finish(connector, paused.id);
  assert.equal(attention.cnkiRetryPaperId, 'CNKI-001'); assert.equal(attention.resumeStage, 'fulltext');
  assert.throws(() => connector.advance(paused.id, { until: 'export' }), /继续这篇知网文献/);
  assert.throws(() => connector.retryCnki(paused.id, 'CNKI-002'), /上一篇/);

  // A broken legacy popup witness is recoverable only via an explicit restart
  // of the already-bound single paper. Normal retry never gets this flag.
  const reposition = fixture(connector, { cnkiRetryPaperId: 'CNKI-001' });
  let restartArgs;
  connector.runStage = async (_script, args, _job, event) => {
    restartArgs = args; event({ type: 'attention', stage: 'verification', message: '等待人工核对入口' });
  };
  connector.restartCnki(reposition.id, 'CNKI-001'); await finish(connector, reposition.id);
  assert.deepEqual(restartArgs, ['--resume', '--only', 'CNKI-001', '--retry-unavailable', '--limit', '1', '--restart-cnki']);
  assert.equal(connector.snapshot(reposition.id).cnkiRetryPaperId, 'CNKI-001');
  assert.throws(() => connector.advance(reposition.id, { until: 'export' }), /继续这篇知网文献/);
  connector.retryCnki(reposition.id, 'CNKI-001'); await finish(connector, reposition.id);
  assert.deepEqual(restartArgs, ['--resume', '--only', 'CNKI-001', '--retry-unavailable', '--limit', '1'], 'ordinary continue never restarts the title lookup');
  const unbound = fixture(connector);
  assert.throws(() => connector.restartCnki(unbound.id, 'CNKI-001'), /只能重新定位/);
  assert.throws(() => connector.restartCnki(reposition.id, 'CNKI-002'), /只能重新定位/);
  const completedBound = fixture(connector, { status: 'completed', cnkiRetryPaperId: 'CNKI-001' });
  assert.throws(() => connector.restartCnki(completedBound.id, 'CNKI-001'), /只能重新定位/);
  const fetchedBound = fixture(connector, { status: 'failed', cnkiRetryPaperId: 'CNKI-001' });
  const fetchedState = JSON.parse(fs.readFileSync(path.join(fetchedBound.dir, 'fulltext', 'status.json')));
  fetchedState.items[0].status = 'fetched_pdf'; write(path.join(fetchedBound.dir, 'fulltext', 'status.json'), fetchedState);
  assert.throws(() => connector.restartCnki(fetchedBound.id, 'CNKI-001'), /只能重试/);
  const downstreamRestart = fixture(connector, { cnkiRetryPaperId: 'CNKI-001' });
  write(path.join(downstreamRestart.dir, 'extraction', 'saved.json'), {});
  assert.throws(() => connector.restartCnki(downstreamRestart.id, 'CNKI-001'), /只能重试/);
  const restarted = new LiteratureConnector(root, { prepare: async () => 'fixture-python' });
  assert.equal(restarted.snapshot(paused.id).cnkiRetryPaperId, 'CNKI-001');
  assert.throws(() => restarted.advance(paused.id, { until: 'fulltext' }), /继续这篇知网文献/);
  let resumed = 0;
  restarted.runStage = async (_script, args, _job, event) => {
    resumed++; assert.equal(args[2], 'CNKI-001'); assert.equal(args[5], '1');
    event({ type: 'result', stage: 'fulltext', count: 0, files: [] });
  };
  restarted.retryCnki(paused.id, 'CNKI-001'); await finish(restarted, paused.id); assert.equal(resumed, 1);

  // A stop during environment resolution prevents a late browser operation.
  let release, late = 0;
  const cancelled = new LiteratureConnector(root, { prepare: () => new Promise(resolve => { release = resolve; }) });
  cancelled.base = path.join(root, 'cancel-test'); cancelled.runStage = async () => { late++; };
  const stopped = fixture(cancelled); cancelled.retryCnki(stopped.id, 'CNKI-001'); cancelled.cancel(stopped.id);
  release('fixture-python'); await turn(); assert.equal(late, 0); assert.equal(cancelled.snapshot(stopped.id).status, 'cancelled');

  // Stop after a file was saved but before its final event: offline review can
  // release a completed single-paper scope, while an unavailable one stays.
  const reviewed = new LiteratureConnector(root, { prepareOffline: async () => 'fixture-python' });
  reviewed.base = path.join(root, 'review-test');
  reviewed.runStage = async (_script, args, _job, event) => {
    assert.deepEqual(args, ['--review-only']); event({ type: 'result', stage: 'fulltext_review', count: 1, files: [] });
  };
  const savedBeforeStop = fixture(reviewed, { status: 'cancelled', cnkiRetryPaperId: 'CNKI-001' });
  const savedStatus = JSON.parse(fs.readFileSync(path.join(savedBeforeStop.dir, 'fulltext', 'status.json')));
  savedStatus.items[0].status = 'fetched_pdf'; write(path.join(savedBeforeStop.dir, 'fulltext', 'status.json'), savedStatus);
  reviewed.reviewFulltext(savedBeforeStop.id); const recovered = await finish(reviewed, savedBeforeStop.id);
  assert.equal(recovered.cnkiRetryPaperId, null); assert.equal(recovered.status, 'needs_attention');
  const stillMissing = fixture(reviewed, { status: 'cancelled', cnkiRetryPaperId: 'CNKI-001' });
  reviewed.reviewFulltext(stillMissing.id); const missing = await finish(reviewed, stillMissing.id);
  assert.equal(missing.cnkiRetryPaperId, 'CNKI-001');

  // A persisted running retry can have zero pending items (attention and
  // unavailable are all settled states). Artifact inference must not promote
  // that interrupted single-paper action to extraction after a restart.
  const crashed = new LiteratureConnector(root, { prepare: async () => 'fixture-python', prepareOffline: async () => 'fixture-python' });
  crashed.base = path.join(root, 'crash-test');
  const interruptedTask = fixture(crashed, { status: 'running', stage: 'fulltext', resumeStage: null, until: 'export',
    activeStage: 'fulltext', cnkiRetryPaperId: 'CNKI-001' });
  const untouched = fs.readFileSync(path.join(interruptedTask.dir, 'job.json'));
  const readonly = crashed.snapshot(interruptedTask.id);
  assert.equal(readonly.status, 'failed'); assert.equal(readonly.stage, 'interrupted');
  assert.equal(readonly.resumeStage, 'fulltext'); assert.equal(readonly.until, 'fulltext');
  assert.equal(readonly.stages.fulltext, 'pending'); assert.equal(readonly.canReviewFulltext, true);
  assert.equal(readonly.cnkiRetryPaperId, 'CNKI-001'); assert.equal(readonly.cnkiRetryItems.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(interruptedTask.dir, 'job.json')), untouched, 'read-only snapshot does not rewrite the interrupted job');
  assert.equal(crashed.list(50).find(job => job.id === interruptedTask.id).resumeStage, 'fulltext');
  assert.throws(() => crashed.advance(interruptedTask.id, { until: 'export' }), /继续这篇知网文献/);
  const loadedCrash = crashed.loadPersisted(interruptedTask.id);
  assert.equal(loadedCrash.status, 'failed'); assert.equal(loadedCrash.resumeStage, 'fulltext');
  assert.equal(loadedCrash.stages.fulltext, 'pending'); assert.equal(loadedCrash.until, 'fulltext');
  assert.throws(() => crashed.advance(interruptedTask.id, { until: 'extract' }), /继续这篇知网文献/);

  // The worker result may have been persisted just before the enclosing
  // single-retry finally block clears its marker. Even an already fetched
  // target must stay at the fulltext gate until explicit offline review.
  const resultCrash = fixture(crashed, { status: 'running', stage: 'fulltext', resumeStage: 'extract', until: 'export',
    activeStage: 'fulltext', cnkiRetryPaperId: 'CNKI-001',
    stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe', 'fulltext'].includes(stage) ? 'done' : 'pending'])) });
  const resultStatus = JSON.parse(fs.readFileSync(path.join(resultCrash.dir, 'fulltext', 'status.json')));
  resultStatus.items[0].status = 'fetched_pdf'; write(path.join(resultCrash.dir, 'fulltext', 'status.json'), resultStatus);
  const resultSnapshot = crashed.snapshot(resultCrash.id);
  assert.equal(resultSnapshot.resumeStage, 'fulltext'); assert.equal(resultSnapshot.stages.fulltext, 'pending');
  assert.equal(resultSnapshot.cnkiRetryPaperId, 'CNKI-001'); assert.equal(resultSnapshot.canReviewFulltext, true);
  assert.throws(() => crashed.advance(resultCrash.id, { until: 'extract' }), /继续这篇知网文献/);
  crashed.runStage = async (_script, args, _job, event) => {
    assert.deepEqual(args, ['--review-only']); event({ type: 'result', stage: 'fulltext_review', count: 1, files: [] });
  };
  crashed.reviewFulltext(resultCrash.id); const afterCrashReview = await finish(crashed, resultCrash.id);
  assert.equal(afterCrashReview.cnkiRetryPaperId, null); assert.equal(afterCrashReview.resumeStage, 'fulltext');

  // A previously persisted failed result with a stale later-stage resume is
  // constrained by its valid marker too; no automatic inference releases it.
  const stale = fixture(crashed, { status: 'failed', stage: 'failed', resumeStage: 'extract', until: 'export', cnkiRetryPaperId: 'CNKI-001' });
  assert.equal(crashed.loadPersisted(stale.id).resumeStage, 'fulltext');
  assert.throws(() => crashed.advance(stale.id, { until: 'export' }), /继续这篇知网文献/);

  // A scoped retry may save/reuse the main PDF, then pause at a supplemental
  // material. Its fetched status must not lock out this same paper's remaining
  // materials, nor permit restart to redownload its already saved main paper.
  const materialsConnector = new LiteratureConnector(root, { prepare: async () => 'fixture-python', prepareOffline: async () => 'fixture-python' });
  materialsConnector.base = path.join(root, 'materials-scope');
  const materialTask = fixture(materialsConnector, { cnkiRetryPaperId: 'CNKI-001' });
  const materialStatusFile = path.join(materialTask.dir, 'fulltext/status.json');
  const materialStatus = JSON.parse(fs.readFileSync(materialStatusFile)); materialStatus.items[0].status = 'fetched_pdf'; write(materialStatusFile, materialStatus);
  fs.mkdirSync(path.join(materialTask.dir, 'fulltext/files'), { recursive: true }); fs.writeFileSync(path.join(materialTask.dir, 'fulltext/files/CNKI-001.pdf'), 'saved-pdf');
  const materialManifest = { version: 1, papers: [{ paper_id: 'CNKI-001', title: '原题名0', main_pdf_status: 'downloaded',
    supplement_check: { status: 'needs_attention', reason: 'Supplement download needs confirmation' }, materials: [
      { material_id: 'main', role: 'main_pdf', path: 'fulltext/files/CNKI-001.pdf', download_status: 'downloaded', size: 9 },
      { material_id: 'S1', role: 'supplement', download_status: 'needs_attention', read_status: 'not_checked' }
    ] }] };
  const materialManifestFile = path.join(materialTask.dir, 'fulltext/materials.json'); write(materialManifestFile, materialManifest);
  const scopedMaterial = materialsConnector.snapshot(materialTask.id).cnkiRetryItems.find(item => item.id === 'CNKI-001');
  assert.equal(scopedMaterial.materials_only, true); assert.match(scopedMaterial.reason, /主文已保存/);
  assert.throws(() => materialsConnector.restartCnki(materialTask.id, 'CNKI-001'), /继续这篇材料/);
  materialsConnector.runStage = async (_script, args, _job, event) => {
    assert.deepEqual(args, ['--resume', '--only', 'CNKI-001', '--retry-unavailable', '--limit', '1']);
    event({ type: 'attention', stage: 'verification', message: 'Supplement still needs confirmation' });
  };
  materialsConnector.retryCnki(materialTask.id, 'CNKI-001'); await finish(materialsConnector, materialTask.id);
  assert.equal(materialsConnector.snapshot(materialTask.id).cnkiRetryPaperId, 'CNKI-001');
  assert.throws(() => materialsConnector.advance(materialTask.id, { until: 'export' }), /继续这篇知网文献/);
  // Merely viewing or reviewing the saved main PDF cannot clear the still
  // pending supplement scope.
  materialsConnector.runStage = async (_script, args, _job, event) => {
    assert.deepEqual(args, ['--review-only']); event({ type: 'result', stage: 'fulltext_review', count: 1, files: [] });
  };
  materialsConnector.reviewFulltext(materialTask.id); await finish(materialsConnector, materialTask.id);
  assert.equal(materialsConnector.snapshot(materialTask.id).cnkiRetryPaperId, 'CNKI-001');
  materialManifest.papers[0].supplement_check.status = 'none_declared'; materialManifest.papers[0].materials.pop(); write(materialManifestFile, materialManifest);
  assert.ok(!materialsConnector.snapshot(materialTask.id).cnkiRetryItems.some(item => item.id === 'CNKI-001'));
  assert.throws(() => materialsConnector.retryCnki(materialTask.id, 'CNKI-001'), /只能重试/);
  console.log('LITERATURE_CNKI_SINGLE_RETRY_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-cnki-single-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
