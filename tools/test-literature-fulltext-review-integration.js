'use strict';

// Real Node -> fixed repo .venv -> offline review. Only temporary task files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const repository = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-review-integration-'));
const write = (file, object) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function main() {
  const connector = new LiteratureConnector(repository, { prepare: async () => { throw new Error('offline review cannot install'); },
    search: async () => { throw new Error('offline review cannot search'); } });
  connector.base = path.join(temporary, 'jobs');
  const id = randomUUID(), dir = path.join(connector.base, id);
  const config = { topic: '离线中文复核', query: 'fixture', sources: ['cnki'], limit: 10 };
  write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'dedupe', 'dedupe.json'), { version: 1, groups: [{ paper_id: 'fixture-001' }, { paper_id: 'fixture-002' }] });
  const cachePath = path.join(dir, 'fulltext', 'files', 'fixture-001.txt'); fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '摘要 Abstract: ' + '仅有题录摘要，不含正文证据。'.repeat(300));
  write(path.join(dir, 'fulltext', 'status.json'), { version: 1, items: [
    { paper_id: 'fixture-001', title: 'Cached fixture', source_url: 'https://kns.cnki.net/kcms2/article/abstract',
      status: 'fetched_html', path: 'fulltext/files/fixture-001.txt', evidence_level: 'fulltext_html' },
    { paper_id: 'fixture-002', title: 'Pending fixture', status: 'pending', path: '' }
  ] });
  write(path.join(dir, 'job.json'), { id, status: 'cancelled', stage: 'cancelled', activeStage: 'fulltext', resumeStage: null,
    until: 'export', config, count: 1, files: ['fulltext/status.json'], counters: {}, events: [],
    stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe'].includes(stage) ? 'done' : stage === 'fulltext' ? 'running' : 'pending'])) });
  const originalStatus = fs.readFileSync(path.join(dir, 'fulltext', 'status.json'));
  const cache = fs.readFileSync(cachePath), frozen = fs.readFileSync(path.join(dir, 'run_config.json'));
  connector.reviewFulltext(id);
  const deadline = Date.now() + 20000;
  let job;
  do { job = connector.snapshot(id); if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.equal(job.status, 'needs_attention', JSON.stringify(job));
  assert.equal(job.resumeStage, 'fulltext'); assert.equal(job.count, 0);
  assert.equal(job.counters.fulltextPending, 1); assert.equal(job.counters.fulltextFetched, 0);
  const report = read(path.join(dir, 'fulltext', 'review.json'));
  assert.equal(report.offline_only, true); assert.equal(report.counts.reviewed, 1); assert.equal(report.counts.changed, 1);
  assert.equal(report.backup, 'fulltext/backups/status-' + crypto.createHash('sha256').update(originalStatus).digest('hex') + '.json');
  assert.deepEqual(fs.readFileSync(path.join(dir, report.backup)), originalStatus);
  assert.deepEqual(fs.readFileSync(cachePath), cache); assert.deepEqual(fs.readFileSync(path.join(dir, 'run_config.json')), frozen);
  assert.equal(read(path.join(dir, 'fulltext', 'status.json')).items[1].status, 'pending');
  assert.ok(!fs.existsSync(path.join(dir, 'fulltext-browser.json')), 'Offline review cannot create a browser binding');
  assert.ok(!fs.existsSync(path.join(dir, 'extraction')), 'Offline review cannot prepare extraction');
  assert.ok(job.files.includes('fulltext/review.json'));
  const reloaded = new LiteratureConnector(repository); reloaded.base = connector.base;
  assert.equal(reloaded.snapshot(id).stage, 'fulltext_review'); assert.equal(reloaded.snapshot(id).resumeStage, 'fulltext');
  console.log('LITERATURE_FULLTEXT_REVIEW_INTEGRATION_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const absolute = path.resolve(temporary);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-review-integration-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
