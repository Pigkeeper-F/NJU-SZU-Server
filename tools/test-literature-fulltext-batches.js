'use strict';

// Connector stage doubles and disposable candidate snapshots; no real tasks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const temporaryBase = path.resolve(__dirname, '../.tmp-literature-tests');
const ID = '52345678-1234-4234-8234-123456789abc';
async function fixture(test) {
  fs.mkdirSync(temporaryBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryBase, 'fulltext-batches-'));
  try {
    const dir = path.join(root, '.workbench/literature', ID);
    fs.mkdirSync(dir, { recursive: true });
    const ids = Array.from({ length: 12 }, (_, i) => 'R' + String(i + 1).padStart(2, '0'));
    const records = ids.map(id => ({ candidate_id: id, title: 'Paper ' + id, abstract: 'Complete controlled heat experiment', source_key: 'cnki' }));
    fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({ records }));
    const order = [], connector = new LiteratureConnector(root);
    const job = { id: ID, dir, config: { query: 'fixture', sources: ['cnki'], screeningPolicy: { id: 'fixture', line: 'production', text: 'approved fixture' }, fulltext: { maxPapers: 0 } },
      status: 'running', stage: 'fulltext', activeStage: 'fulltext', until: 'fulltext', runId: 1, resumeRun: false,
      stages: Object.fromEntries(STAGES.map(stage => [stage, stage === 'fulltext' ? 'running' : 'done'])), counters: {}, events: [], files: [] };
    connector.jobs.set(ID, job);
    connector.screen = async (_job, _python, emit, signal, scope) => {
      assert.equal(signal.aborted, false);
      const paperIds = scope.paperIds; order.push(['screen', paperIds]);
      emit({ type: 'result', stage: 'screening', counts: { include: ids.indexOf(paperIds.at(-1)) + 1, pending: 0, exclude: 0, unscreened: 12 - ids.indexOf(paperIds.at(-1)) - 1 } });
      assert.equal(job.stages.fulltext, 'running');
      return { ok: true, selectedPaperIds: paperIds };
    };
    connector.runStage = async (script, args, current, emit) => {
      assert.equal(script, 'literature_fulltext.py');
      assert.ok(args.includes('--resume') && args.includes('--screening-batch'));
      assert.equal(args.includes('--skip-unavailable'), current.fulltextFailurePolicy === 'skip',
        'Each batch preserves the explicitly selected fulltext failure policy');
      const paperIds = args[args.indexOf('--only') + 1].split(','); order.push(['download', paperIds]);
      assert.equal(job.stages.fulltext, 'running');
      emit({ type: 'result', stage: 'fulltext', selected_paper_ids: paperIds, batch_complete: true,
        scope_complete: paperIds.at(-1) === ids.at(-1), quota_reached: false,
        count: ids.indexOf(paperIds.at(-1)) + 1, counts: { fetched_pdf: ids.indexOf(paperIds.at(-1)) + 1 }, files: [] });
      assert.equal(job.stages.fulltext, 'running', 'Intermediate process results are never global completion');
    };
    await test({ root, job, connector, ids, order });
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== temporaryBase || !path.basename(absolute).startsWith('fulltext-batches-')) throw new Error('Unsafe fixture path');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
async function main() {
  await fixture(async ({ job, connector, ids, order }) => {
    await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
    assert.deepEqual(order, [['screen', ids.slice(0, 10)], ['download', ids.slice(0, 10)], ['screen', ids.slice(10)], ['download', ids.slice(10)]]);
    assert.equal(job.stages.fulltext, 'done');
    assert.equal(job.counters.fulltextFetched, 12);
  });
  for (const policy of ['pause', 'skip']) {
    await fixture(async ({ job, connector, ids, order }) => {
      job.resumeRun = true;
      job.fulltextFailurePolicy = policy;
      await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
      assert.deepEqual(order, [['screen', ids.slice(0, 10)], ['download', ids.slice(0, 10)], ['screen', ids.slice(10)], ['download', ids.slice(10)]]);
      assert.equal(job.stages.fulltext, 'done');
      assert.equal(job.counters.fulltextFetched, 12);
    });
    await fixture(async ({ job, connector, order }) => {
      job.resumeRun = true;
      job.fulltextFailurePolicy = policy;
      connector.runStage = async (_script, args, _job, emit) => {
        assert.equal(args.includes('--skip-unavailable'), policy === 'skip');
        emit({ type: 'attention', stage: 'fulltext', reason: 'login', message: 'Fixture access barrier' });
      };
      await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
      assert.equal(order.length, 1, 'An emitted access barrier stops further batches even with skip selected');
      assert.equal(job.status, 'needs_attention');
      assert.equal(job.stages.fulltext, 'pending');
    });
  }
  await fixture(async ({ job, connector, order }) => {
    const screen = connector.screen;
    connector.screen = async (...args) => {
      const result = await screen(...args);
      connector.cancel(job.id);
      return result;
    };
    await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
    assert.equal(order.length, 1);
    assert.equal(job.status, 'cancelled');
    assert.notEqual(job.stages.fulltext, 'done');
  });
  for (const kind of ['screen-scope', 'missing-result', 'download-scope', 'incomplete', 'global-incomplete']) {
    await fixture(async ({ job, connector, ids, order }) => {
      if (kind === 'screen-scope') connector.screen = async () => ({ ok: true, selectedPaperIds: ids.slice(1, 10) });
      else connector.runStage = async (_script, args, _job, emit) => {
        if (kind === 'missing-result') return;
        const paperIds = args[args.indexOf('--only') + 1].split(',');
        emit({ type: 'result', stage: 'fulltext', selected_paper_ids: kind === 'download-scope' ? ['unknown'] : paperIds,
          batch_complete: kind !== 'incomplete', scope_complete: false, quota_reached: false, counts: {}, files: [] });
      };
      await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
      assert.equal(job.status, 'needs_attention', kind);
      assert.notEqual(job.stages.fulltext, 'done', kind);
      assert.ok(order.length <= (kind === 'global-incomplete' ? 2 : 1));
    });
  }
  await fixture(async ({ job, connector, order }) => {
    job.config.fulltext.maxPapers = 1;
    connector.runStage = async (_script, args, _job, emit) => emit({ type: 'result', stage: 'fulltext',
      selected_paper_ids: args[args.indexOf('--only') + 1].split(','), batch_complete: false,
      scope_complete: false, quota_reached: true, count: 1, counts: { fetched_pdf: 1 }, files: [] });
    await connector.runSingleStage(job, 'fake-python', 'fulltext', 1);
    assert.equal(order.length, 1, 'Configured cap stops subsequent screening batches');
    assert.equal(job.stages.fulltext, 'done');
    assert.equal(job.counters.fulltextFetched, 1);
    assert.match(job.message, /上限/);
  });
  console.log('LITERATURE_FULLTEXT_BATCH_CONNECTOR_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
