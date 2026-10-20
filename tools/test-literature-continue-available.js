'use strict';

// Only isolated candidate/checkpoint fixtures; no Python, browser, or real job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LiteratureConnector, STAGES, __internals } = require('./literature-connector');
const { backendFingerprint } = require('./literature-runtime');

const ID = '12345678-1234-4234-8234-123456789abc';
const sources = ['pubmed', 'scopus', 'web-of-science'];
function write(file, object) { fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fixture(root) {
  const dir = path.join(root, '.workbench', 'literature', ID);
  fs.mkdirSync(dir, { recursive: true });
  const config = { version: 2, topic: 'fixture', query: 'broiler heat stress', sources, limit: 10 };
  write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'candidates.json'), { count: 2, discovery_complete: false, batches: [{ status: 'partial' }],
    records: [{ candidate_id: 'fixture-1', title: 'First heat stress study' }, { candidate_id: 'fixture-2', title: 'Second heat stress study' }] });
  fs.writeFileSync(path.join(dir, 'candidates.csv'), '\ufeffcandidate_id,title\r\nfixture-1,First heat stress study\r\nfixture-2,Second heat stress study\r\n');
  write(path.join(dir, 'discovery-state.json'), { pending_source: 'web-of-science', pending_reason: 'results_unrecognized',
    deferred_sources: ['web-of-science'], sources: { pubmed: { status: 'ok' }, scopus: { status: 'ok' },
      'web-of-science': { status: 'attention', next_page: 3 } } });
  write(path.join(dir, 'browser-tabs.json'), { 'web-of-science': { target_id: 'untouched-official-tab', page_index: 2 } });
  write(path.join(dir, 'job.json'), { id: ID, config, status: 'needs_attention', resumeStage: 'discover', until: 'dedupe',
    stage: 'verification', count: 2, deferredOnly: false, deferredSources: [],
    attention: { source: 'web-of-science', reason: 'results_unrecognized' },
    files: ['run_config.json', 'candidates.json', 'candidates.csv'], stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])),
    events: [], counters: { candidates: 2 } });
  return dir;
}
function bytes(dir) { return fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]); }
async function settled(connector, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = connector.snapshot(id);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('isolated processing run did not settle');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-available-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    let fingerprint = backendFingerprint(root);
    for (const name of ['literature_source_runner.py', 'literature_source_worker.py', 'literature_source_guard.py']) {
      fs.writeFileSync(path.join(root, 'tools', name), '# isolated worker fixture\n');
      assert.notEqual(backendFingerprint(root), fingerprint, `${name} must participate in the loaded-backend fingerprint`);
      fingerprint = backendFingerprint(root);
    }
    const dir = fixture(root);
    let connector = new LiteratureConnector(root, { prepare: async () => 'mock-python' });
    assert.equal(connector.snapshot(ID).deferredOnly, true, 'real CP overrides saved UI flag');
    assert.equal(connector.list(10)[0].deferredOnly, true);
    assert.equal(connector.public(connector.loadPersisted(ID)).deferredOnly, true);
    const parentBefore = bytes(dir);
    const scripts = [];
    connector.runStage = async (script, args, job, emit) => {
      scripts.push(script);
      assert.equal(script, 'literature_dedupe.py', 'never start search for a processing snapshot');
      assert.notEqual(job.id, ID);
      assert.equal(job.stages.discover, 'done', 'only the input snapshot is ready');
      assert.equal(read(path.join(job.dir, 'candidates.json')).discovery_complete, false);
      for (const name of ['run_config.json', 'candidates.json', 'candidates.csv']) {
        assert.deepEqual(fs.readFileSync(path.join(job.dir, name)), fs.readFileSync(path.join(dir, name)));
      }
      assert.equal(fs.existsSync(path.join(job.dir, 'discovery-state.json')), false);
      assert.equal(fs.existsSync(path.join(job.dir, 'browser-tabs.json')), false);
      fs.mkdirSync(path.join(job.dir, 'dedupe'));
      write(path.join(job.dir, 'dedupe', 'dedupe.json'), { version: 1, groups: [] });
      emit({ type: 'result', stage: 'dedupe', count: 2, files: ['dedupe/dedupe.json'], counts: { groups: 2 } });
    };
    const child = connector.continueAvailable(ID, { until: 'dedupe' });
    const done = await settled(connector, child.id);
    assert.deepEqual(scripts, ['literature_dedupe.py']);
    assert.equal(done.status, 'completed');
    assert.equal(done.resumeStage, 'fulltext');
    assert.equal(done.deferredOnly, false);
    assert.equal(done.processingBasis.parentJobId, ID);
    assert.equal(done.processingBasis.candidateCount, 2);
    assert.deepEqual(done.processingBasis.deferredSources, ['web-of-science']);
    assert.equal(done.processingBasis.candidateSnapshotSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'candidates.json'))).digest('hex'));
    assert.deepEqual(bytes(dir), parentBefore, 'creating/running child never rewrites parent bytes');
    const childDir = path.join(root, '.workbench', 'literature', child.id);
    assert.equal(connector.download(child.id, 'processing-basis.json'), path.join(childDir, 'processing-basis.json'));
    assert.equal(__internals.detectStagedArtifacts(childDir).stages.discover, 'done');
    connector = new LiteratureConnector(root);
    assert.deepEqual(connector.snapshot(child.id).processingBasis, done.processingBasis);
    assert.deepEqual(connector.list(10).find(item => item.id === child.id).processingBasis, done.processingBasis);
    assert.deepEqual(connector.loadPersisted(child.id).processingBasis, done.processingBasis);
    connector.deleteJob(child.id);
    assert.deepEqual(connector.restoreJob(child.id).processingBasis, done.processingBasis);
    // Later parent discoveries cannot silently join the child input snapshot.
    const later = read(path.join(dir, 'candidates.json'));
    later.records.push({ candidate_id: 'late-parent', title: 'Late added result' }); later.count++;
    write(path.join(dir, 'candidates.json'), later);
    assert.equal(read(path.join(childDir, 'candidates.json')).count, 2);
    assert.equal(connector.snapshot(child.id).processingBasis.candidateCount, 2);
    // A restart during later processing resumes after the verified input stage.
    const savedChild = read(path.join(childDir, 'job.json'));
    savedChild.status = 'running'; write(path.join(childDir, 'job.json'), savedChild);
    const restarted = new LiteratureConnector(root).loadPersisted(child.id);
    assert.equal(restarted.stages.discover, 'done');
    assert.equal(restarted.resumeStage, 'fulltext');

    const invalids = [
      { until: 'discover' }, { until: 'unknown' }, { until: null },
      { job: state => { state.deletedAt = new Date().toISOString(); } },
      { job: state => { state.status = 'running'; } },
      { job: state => { state.status = 'completed'; } },
      { cp: state => { state.sources.scopus = { status: 'pending' }; } },
      { cp: state => { delete state.sources.scopus; } },
      { cp: state => { state.deferred_sources = []; } },
      { cp: state => { state.deferred_sources = ['web-of-science', 'web-of-science']; } },
      { cp: state => { state.deferred_sources = ['unselected']; } },
      { cp: state => { state.pending_source = 'scopus'; } },
      { candidates: state => { state.count = 0; state.records = []; } },
      { candidates: state => { state.records = []; } }
    ];
    for (const invalid of invalids) {
      fixture(root);
      for (const [key, name] of [['job', 'job.json'], ['cp', 'discovery-state.json'], ['candidates', 'candidates.json']]) {
        if (invalid[key]) { const state = read(path.join(dir, name)); invalid[key](state); write(path.join(dir, name), state); }
      }
      const before = bytes(dir), count = fs.readdirSync(path.join(root, '.workbench', 'literature')).length;
      const guarded = new LiteratureConnector(root, { prepare: async () => { throw new Error('must not run'); } });
      assert.throws(() => guarded.continueAvailable(ID, { until: Object.hasOwn(invalid, 'until') ? invalid.until : 'dedupe' }));
      assert.deepEqual(bytes(dir), before, 'invalid request must not mutate parent');
      assert.equal(fs.readdirSync(path.join(root, '.workbench', 'literature')).length, count);
      assert.equal(guarded.jobs.size, 0);
    }
    fixture(root);
    const cp = read(path.join(dir, 'discovery-state.json'));
    cp.sources.scopus.status = 'attention'; cp.deferred_sources.push('scopus'); write(path.join(dir, 'discovery-state.json'), cp);
    assert.equal(new LiteratureConnector(root).snapshot(ID).deferredOnly, true, 'all remaining sources may be deferred');
    cp.sources.scopus.status = 'pending'; cp.deferred_sources.pop(); write(path.join(dir, 'discovery-state.json'), cp);
    assert.equal(new LiteratureConnector(root).snapshot(ID).deferredOnly, false, 'untried selected source is not deferred-only');
    console.log('LITERATURE_CONTINUE_AVAILABLE_TESTS_PASS');
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-available-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
