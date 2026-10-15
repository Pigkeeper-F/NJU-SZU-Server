'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteratureConnector } = require('./literature-connector');
const { normalizeConfig } = require('./literature-config');

const config = { topic: '气候变化与养殖', query: 'climate change aquaculture China', sources: ['google-scholar'], publicationYearFrom: 2000, publicationYearTo: 2026,
  geography: '中国', language: '', studyTypes: ['原始研究'], inclusion: [], exclusion: [], targetFields: ['产量'], limit: 10 };

async function waitDone(connector, id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = connector.snapshot(id);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('mock connector did not finish');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-literature-test-'));
  try {
    const connector = new LiteratureConnector(root, {
      prepare: async (_job, progress) => { progress('environment', 'mock ready'); return 'mock-python'; },
      search: async (job, _python, onEvent) => {
        onEvent({ type: 'stage', stage: 'search', message: 'mock search' });
        fs.writeFileSync(path.join(job.dir, 'candidates.json'), '{"records":[]}');
        fs.writeFileSync(path.join(job.dir, 'candidates.csv'), 'title\n');
        onEvent({ type: 'result', count: 0, files: ['candidates.json', 'candidates.csv'], message: 'mock complete' });
      }
    });
    assert.throws(() => connector.start({ ...config, topic: '' }), /研究主题/);
    assert.throws(() => connector.start({ ...config, limit: 11 }), /1–10/);
    assert.throws(() => connector.start({ ...config, sources: ['google-scholar', 'scopus'] }), /尚未接通/);
    assert.throws(() => normalizeConfig({ ...config, publicationYearFrom: 2026, publicationYearTo: 2000 }), /不能晚于/);
    const started = connector.start(config);
    const done = await waitDone(connector, started.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.config.query, config.query);
    assert.deepEqual(done.files, ['run_config.json', 'candidates.json', 'candidates.csv']);
    assert.deepEqual(JSON.parse(fs.readFileSync(connector.download(done.id, 'run_config.json'), 'utf8')).publicationYearFrom, 2000);
    assert.equal(fs.readFileSync(connector.download(done.id, 'candidates.csv'), 'utf8'), 'title\n');
    assert.throws(() => connector.download(done.id, '../job.json'), /不存在/);
    const reloaded = new LiteratureConnector(root);
    assert.equal(reloaded.snapshot(done.id).status, 'completed');
    assert.ok(done.events.some(event => event.stage === 'search'));
    console.log('LITERATURE_CONNECTOR_TESTS_PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
