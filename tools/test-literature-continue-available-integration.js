'use strict';

// Real Node -> .venv Python -> dedupe outputs, entirely inside os.tmpdir.
// No server, search adapter, browser, network, or real task directory is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');

const ID = '22345678-1234-4234-8234-123456789abc';
const repository = path.resolve(__dirname, '..');
const python = path.join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function write(file, object) { fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function parentBytes(dir) {
  return fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]);
}

async function main() {
  assert.ok(fs.existsSync(python), 'integration requires the existing repo .venv Python; it does not install dependencies');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-available-integration-'));
  let connector;
  try {
    const base = path.join(temporary, 'jobs'), dir = path.join(base, ID);
    fs.mkdirSync(dir, { recursive: true });
    const config = { version: 2, topic: 'isolated real dedupe fixture', query: 'broiler heat stress',
      sources: ['pubmed', 'scopus', 'web-of-science'], limit: 10 };
    const records = [
      { candidate_id: 'fixture-pubmed-001', title: 'Controlled heat exposure and broiler growth',
        doi: '10.1234/fixture.heat', source_key: 'pubmed', year: '2024', batch_index: 1 },
      { candidate_id: 'fixture-scopus-002', title: 'Broiler production under thermal treatment',
        doi: 'https://doi.org/10.1234/FIXTURE.HEAT', source_key: 'scopus', year: '2024', batch_index: 1 },
      { candidate_id: 'fixture-scopus-003', title: 'Independent aquatic salinity observation',
        doi: '10.5678/fixture.salinity', source_key: 'scopus', year: '2023', batch_index: 1 }
    ];
    write(path.join(dir, 'run_config.json'), config);
    write(path.join(dir, 'candidates.json'), { version: 2, count: records.length, discovery_complete: false,
      deferred_sources: ['web-of-science'], batches: [{ index: 1, status: 'partial' }], records });
    fs.writeFileSync(path.join(dir, 'candidates.csv'), '\ufeffcandidate_id,title,doi\r\n' + records.map(record =>
      `${record.candidate_id},${record.title},${record.doi}`).join('\r\n') + '\r\n');
    write(path.join(dir, 'discovery-state.json'), { pending_source: 'web-of-science', pending_reason: 'results_unrecognized',
      deferred_sources: ['web-of-science'], sources: { pubmed: { status: 'ok' }, scopus: { status: 'ok' },
        'web-of-science': { status: 'attention', next_page: 2 } } });
    write(path.join(dir, 'browser-tabs.json'), { 'web-of-science': { target_id: 'untouched-fixture-target', page_index: 1 } });
    write(path.join(dir, 'job.json'), { id: ID, config, status: 'needs_attention', resumeStage: 'discover', until: 'dedupe',
      stage: 'verification', count: records.length, attention: { source: 'web-of-science', reason: 'results_unrecognized' },
      files: ['run_config.json', 'candidates.json', 'candidates.csv'],
      stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])), events: [], counters: { candidates: records.length } });
    const unchanged = parentBytes(dir);
    let prepareCount = 0, searchCount = 0;
    connector = new LiteratureConnector(repository, {
      prepare: async () => { prepareCount++; return python; },
      search: async () => { searchCount++; throw new Error('integration must never search or open a browser'); }
    });
    connector.base = base;
    const child = connector.continueAvailable(ID, { until: 'dedupe' });
    const deadline = Date.now() + 20000;
    let completed;
    do {
      completed = connector.snapshot(child.id);
      if (completed.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(completed.status, 'completed', JSON.stringify({ status: completed.status, error: completed.error, message: completed.message }));
    assert.equal(prepareCount, 1);
    assert.equal(searchCount, 0);
    assert.equal(completed.stages.discover, 'done', 'only frozen candidate inputs are ready');
    assert.equal(completed.stages.dedupe, 'done');
    assert.equal(completed.resumeStage, 'fulltext');
    assert.equal(completed.counters.uniqueGroups, 2);
    const childDir = path.join(base, child.id);
    const dedupe = read(path.join(childDir, 'dedupe', 'dedupe.json'));
    assert.deepEqual(dedupe.counts, { records_in: 3, groups: 2, merged: 1, needs_review_groups: 0 });
    const duplicate = dedupe.groups.find(group => group.candidate_ids.length === 2);
    assert.ok(duplicate, 'real Python dedupe must merge the matching DOI pair');
    assert.equal(duplicate.merge_reason, 'doi_exact');
    assert.deepEqual(duplicate.candidate_ids, ['fixture-pubmed-001', 'fixture-scopus-002']);
    assert.equal(duplicate.records[1].screening_status, 'auto_excluded_duplicate');
    assert.ok(fs.statSync(path.join(childDir, 'dedupe', 'dedupe.csv')).size > 0);
    assert.ok(completed.files.includes('dedupe/dedupe.json') && completed.files.includes('dedupe/dedupe.csv'));
    for (const name of ['run_config.json', 'candidates.json', 'candidates.csv']) {
      assert.deepEqual(fs.readFileSync(path.join(childDir, name)), fs.readFileSync(path.join(dir, name)), `${name} is an exact snapshot`);
    }
    assert.equal(read(path.join(childDir, 'candidates.json')).discovery_complete, false, 'partial source coverage is not relabeled complete');
    assert.equal(completed.processingBasis.candidateCount, 3);
    assert.deepEqual(completed.processingBasis.deferredSources, ['web-of-science']);
    assert.equal(completed.processingBasis.candidateSnapshotSha256,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(childDir, 'candidates.json'))).digest('hex'));
    assert.deepEqual(parentBytes(dir), unchanged, 'all parent task bytes, page proof, and queue stay unchanged');
    assert.equal(fs.existsSync(path.join(childDir, 'discovery-state.json')), false);
    assert.equal(fs.existsSync(path.join(childDir, 'browser-tabs.json')), false);
    const restarted = new LiteratureConnector(repository); restarted.base = base;
    assert.deepEqual(restarted.snapshot(child.id).processingBasis, completed.processingBasis);
    console.log('LITERATURE_CONTINUE_AVAILABLE_REAL_DEDUPE_INTEGRATION_PASS');
  } finally {
    if (connector) {
      for (const job of connector.jobs.values()) {
        if (job.child && job.status === 'running') {
          const child = job.child;
          connector.cancel(job.id);
          await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('close', resolve); });
        }
      }
    }
    const absolute = path.resolve(temporary);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-available-integration-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
