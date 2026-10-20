'use strict';

// Isolated task fixtures only: no database browser, downloads or real jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-fulltext-review-'));
const copy = value => JSON.parse(JSON.stringify(value));
const delay = () => new Promise(resolve => setImmediate(resolve));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value) + '\n'); };
function fixture(connector, patch = {}) {
  const id = randomUUID(), dir = path.join(connector.base, id);
  const config = { topic: 'fixture', query: 'fixture', sources: ['cnki'], limit: 10 };
  const saved = { id, status: 'cancelled', stage: 'cancelled', resumeStage: null, activeStage: 'fulltext', until: 'export',
    config, count: 2, files: ['fulltext/status.json'], counters: {}, events: [],
    stages: Object.fromEntries(STAGES.map(key => [key, ['discover', 'dedupe'].includes(key) ? 'done' : key === 'fulltext' ? 'running' : 'pending'])), ...patch };
  write(path.join(dir, 'job.json'), saved); write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'dedupe', 'dedupe.json'), { version: 1, groups: [{ paper_id: 'fixture' }] });
  write(path.join(dir, 'fulltext', 'status.json'), { items: [{ paper_id: 'fixture', status: 'fetched_html', path: 'fulltext/files/fixture.txt' }] });
  return { id, dir, saved };
}
async function finish(connector, id) {
  for (let i = 0; i < 100; i++) { if (connector.snapshot(id).status !== 'running') return connector.snapshot(id); await delay(); }
  throw new Error('fixture did not finish');
}
async function main() {
  let prepared = 0, reviews = 0, opened = 0, searches = 0;
  const connector = new LiteratureConnector(root, {
    prepare: async () => { searches++; throw new Error('review cannot install or search'); },
    prepareOffline: async () => { prepared++; return 'fixture-python'; },
    openFulltext: async () => { opened++; return { opened: true }; },
    search: async () => { searches++; }
  });
  connector.runStage = async (script, args, job, event) => {
    assert.equal(script, 'literature_fulltext.py'); assert.deepEqual(args, ['--review-only']); reviews++;
    write(path.join(job.dir, 'fulltext', 'review.json'), { reviewed: 1, changed: 1 });
    event({ type: 'result', stage: 'fulltext_review', count: 0, counts: { fetched_pdf: 0, fetched_html: 0, abstract_only: 1, unavailable: 0, needs_attention: 0, pending: 0 },
      files: ['fulltext/status.json', 'fulltext/review.json', '../secret'] });
  };
  const original = fixture(connector), frozen = fs.readFileSync(path.join(original.dir, 'run_config.json'));
  assert.equal(connector.snapshot(original.id).canReviewFulltext, true);
  assert.equal(connector.reviewFulltext(original.id).status, 'running');
  assert.throws(() => connector.reviewFulltext(original.id), /正在运行/);
  const reviewed = await finish(connector, original.id);
  assert.equal(reviewed.status, 'needs_attention'); assert.equal(reviewed.resumeStage, 'fulltext');
  assert.equal(reviewed.stage, 'fulltext_review'); assert.equal(reviewed.counters.fulltextAbstract, 1);
  assert.ok(reviewed.files.includes('fulltext/review.json')); assert.ok(!reviewed.files.includes('../secret'));
  assert.match(reviewed.message, /尚未继续获取全文/); assert.equal(searches, 0); assert.equal(reviews, 1);
  assert.deepEqual(fs.readFileSync(path.join(original.dir, 'run_config.json')), frozen);
  assert.deepEqual(await connector.openLogin(original.id), { opened: true, stage: 'fulltext', label: '原全文任务页' });
  assert.equal(opened, 1);
  const loaded = new LiteratureConnector(root, { prepareOffline: async () => 'fixture-python' });
  assert.equal(loaded.snapshot(original.id).canReviewFulltext, true); assert.equal(loaded.snapshot(original.id).resumeStage, 'fulltext');
  for (const downstream of ['extraction', 'validation', 'export']) {
    const task = fixture(connector); write(path.join(task.dir, downstream, 'saved.json'), {});
    assert.equal(connector.snapshot(task.id).canReviewFulltext, false);
    assert.throws(() => connector.reviewFulltext(task.id), /尚未生成/);
  }
  const discovery = fixture(connector, { activeStage: 'discover', stages: { discover: 'pending', fulltext: 'pending' } });
  assert.throws(() => connector.reviewFulltext(discovery.id), /只能复核/);
  assert.throws(() => connector.advance(discovery.id, { until: 'discover' }), /已停止/);
  const deleted = fixture(connector, { deletedAt: '2026-10-20T00:00:00Z' });
  assert.throws(() => connector.reviewFulltext(deleted.id), /只能复核/);
  assert.throws(() => connector.reviewFulltext('../bad'), /无效/);

  // Cancellation during environment resolution cannot start a late review.
  let release;
  const cancelled = new LiteratureConnector(root, { prepareOffline: () => new Promise(resolve => { release = resolve; }) });
  cancelled.base = path.join(root, 'cancellation');
  let late = 0; cancelled.runStage = async () => { late++; };
  const cancelledTask = fixture(cancelled);
  cancelled.reviewFulltext(cancelledTask.id); cancelled.cancel(cancelledTask.id); release('fixture-python'); await delay();
  assert.equal(late, 0); assert.equal(cancelled.snapshot(cancelledTask.id).status, 'cancelled');

  // Once already running, late NDJSON after stop cannot resurrect the job.
  let emit, resolveStage;
  cancelled.prepareOffline = async () => 'fixture-python';
  cancelled.runStage = async (_script, _args, _job, onEvent) => { emit = onEvent; await new Promise(resolve => { resolveStage = resolve; }); };
  cancelled.reviewFulltext(cancelledTask.id); await delay(); cancelled.cancel(cancelledTask.id);
  emit({ type: 'result', stage: 'fulltext_review', count: 99, counts: { fetched_html: 99 }, files: [] }); resolveStage(); await delay();
  assert.equal(cancelled.snapshot(cancelledTask.id).status, 'cancelled'); assert.notEqual(cancelled.snapshot(cancelledTask.id).count, 99);

  // A requested full pipeline has an explicit stop between full text and data extraction.
  const gate = new LiteratureConnector(root, { prepare: async () => 'fixture-python' }); gate.base = path.join(root, 'gate');
  const gated = fixture(gate, { status: 'completed', stage: 'completed', resumeStage: 'fulltext', stages: { discover: 'done', dedupe: 'done', fulltext: 'pending', extract: 'pending', validate: 'pending', export: 'pending' } });
  const stages = [];
  gate.runSingleStage = async (job, _python, stage, runId) => { stages.push(stage); gate.onStageEvent(job, runId, stage, { type: 'result', stage, count: 1, files: [] }); };
  gate.advance(gated.id, { until: 'export' }); const gatedResult = await finish(gate, gated.id);
  assert.deepEqual(stages, ['fulltext']); assert.equal(gatedResult.resumeStage, 'extract'); assert.equal(gatedResult.stage, 'fulltext_ready');
  assert.equal(gatedResult.status, 'needs_attention'); assert.ok(prepared >= 1);
  const partial = fixture(gate, { status: 'needs_attention', resumeStage: 'fulltext' });
  const partialJob = gate.loadPersisted(partial.id); partialJob.status = 'running'; partialJob.runId = 1;
  fs.mkdirSync(path.join(partial.dir, 'fulltext', 'files'), { recursive: true });
  fs.writeFileSync(path.join(partial.dir, 'fulltext', 'files', 'kept.txt'), 'fixture body');
  write(path.join(partial.dir, 'fulltext', 'status.json'), { items: [
    { status: 'fetched_html', path: 'fulltext/files/kept.txt' }, { status: 'needs_attention' }, { status: 'pending' }
  ] });
  gate.onStageEvent(partialJob, 1, 'fulltext', { type: 'attention', stage: 'verification', message: '当前文章页面404，已暂停' });
  const partialSnapshot = gate.snapshot(partial.id);
  assert.equal(partialSnapshot.counters.fulltextFetched, 1); assert.equal(partialSnapshot.counters.fulltextAttention, 1);
  assert.equal(partialSnapshot.counters.fulltextPending, 1); assert.ok(partialSnapshot.files.includes('fulltext/files/kept.txt'));
  assert.equal(partialSnapshot.message, '当前文章页面404，已暂停');
  console.log('LITERATURE_FULLTEXT_REVIEW_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-fulltext-review-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
