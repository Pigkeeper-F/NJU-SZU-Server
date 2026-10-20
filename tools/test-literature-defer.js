'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteratureConnector, STAGES, __internals } = require('./literature-connector');

const ID = '12345678-1234-4234-8234-123456789abc';
const SOURCE = 'web-of-science';
const sources = ['pubmed', 'scopus', 'wanfang', SOURCE, 'google-scholar', 'cnki'];
const config = { version: 2, topic: 'fixture', query: 'broiler "heat stress"', sources,
  sourceQueries: { [SOURCE]: 'TS=(broiler AND "heat stress")' }, limit: 10, searchMode: 'test',
  stopMode: 'count', perSourceLimit: 10 };

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function fixture(root) {
  const dir = path.join(root, '.workbench', 'literature', ID);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'run_config.json'), config);
  writeJson(path.join(dir, 'browser-tabs.json'), { [SOURCE]: { target_id: 'same-official-target', query_hash: '' } });
  writeJson(path.join(dir, 'candidates.json'), { count: 30, discovery_complete: false, batches: [{ status: 'partial' }], records: [] });
  fs.writeFileSync(path.join(dir, 'candidates.csv'), 'candidate_id\nfixture-001\n');
  writeJson(path.join(dir, 'discovery-state.json'), { version: 1, pending_source: SOURCE, pending_reason: 'results_unrecognized',
    sources: Object.fromEntries(sources.map(source => [source, { status: source === SOURCE ? 'attention' : 'ok', results: [] }])),
    deferred_sources: [] });
  writeJson(path.join(dir, 'job.json'), { id: ID, config, status: 'needs_attention', stage: 'verification',
    resumeStage: 'discover', until: 'dedupe', count: 30, events: [], error: null,
    attention: { source: SOURCE, reason: 'results_unrecognized' }, files: ['run_config.json', 'candidates.json', 'candidates.csv'],
    stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])), counters: { candidates: 30 } });
  return dir;
}

async function settled(connector) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = connector.snapshot(ID);
    if (state.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('defer fixture did not settle');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-defer-'));
  try {
    const dir = fixture(root);
    const frozen = fs.readFileSync(path.join(dir, 'run_config.json'), 'utf8');
    const bound = fs.readFileSync(path.join(dir, 'browser-tabs.json'), 'utf8');
    const originalCheckpoint = fs.readFileSync(path.join(dir, 'discovery-state.json'), 'utf8');
    let discoverCalls = 0, dedupeCalls = 0;
    let connector = new LiteratureConnector(root, { prepare: async () => 'fixture-python' });
    connector.runStage = async (script, args, job, emit) => {
      assert.equal(script, 'literature_search.py', 'deferred partial must never reach dedupe');
      discoverCalls++;
      assert.ok(args.includes('--resume'));
      assert.equal(args[args.indexOf('--defer-source') + 1], SOURCE);
      assert.ok(!args.includes('--scrape-current'), 'deferral must not inspect the postponed login page');
      assert.equal(job.id, ID);
      assert.equal(job.count, 30);
      assert.equal(job.until, 'dedupe');
      assert.equal(fs.readFileSync(path.join(dir, 'discovery-state.json'), 'utf8'), originalCheckpoint,
        'Node must not modify the checkpoint before Python');
      const state = readJson(path.join(dir, 'discovery-state.json'));
      state.deferred_sources = [SOURCE];
      writeJson(path.join(dir, 'discovery-state.json'), state); // Python fixture owns the checkpoint.
      writeJson(path.join(dir, 'candidates.json'), { count: 50, discovery_complete: false,
        batches: [{ status: 'partial' }], records: [] });
      emit({ type: 'stage', stage: 'search', message: 'other selected sources processed', count: 50, deferred_sources: [SOURCE] });
      // Even a broken result emitter cannot promote a partial/deferred report.
      emit({ type: 'result', stage: 'discover', count: 50, files: ['candidates.json', 'candidates.csv'], deferred_sources: [SOURCE] });
    };
    connector.advance(ID, { deferSource: SOURCE });
    let job = await settled(connector);
    assert.equal(discoverCalls, 1);
    assert.equal(job.status, 'needs_attention');
    assert.equal(job.resumeStage, 'discover');
    assert.equal(job.stages.discover, 'pending', 'incomplete discovery must not be marked done');
    assert.equal(job.until, 'dedupe');
    assert.equal(job.count, 50);
    assert.deepEqual(job.deferredSources, [SOURCE]);
    assert.deepEqual(job.executionOrder, [...sources.filter(source => source !== SOURCE), SOURCE]);
    assert.equal(job.attention.source, SOURCE);
    assert.equal(connector.download(ID, 'candidates.csv'), path.join(dir, 'candidates.csv'));
    assert.equal(fs.readFileSync(path.join(dir, 'run_config.json'), 'utf8'), frozen);
    assert.equal(fs.readFileSync(path.join(dir, 'browser-tabs.json'), 'utf8'), bound);
    assert.equal(fs.readdirSync(path.join(root, '.workbench', 'literature')).length, 1);
    assert.equal(__internals.detectStagedArtifacts(dir).stages.discover, 'pending');

    // The checkpoint, not possibly stale saved UI metadata, owns this queue.
    const saved = readJson(path.join(dir, 'job.json'));
    saved.deferredSources = ['cnki', 'unselected'];
    writeJson(path.join(dir, 'job.json'), saved);
    connector = new LiteratureConnector(root, { prepare: async () => 'fixture-python' });
    assert.deepEqual(connector.snapshot(ID).deferredSources, [SOURCE]);
    assert.deepEqual(connector.list(10)[0].deferredSources, [SOURCE]);
    assert.deepEqual(connector.loadPersisted(ID).deferredSources, [SOURCE]);
    connector.runStage = async (script, args, current, emit) => {
      if (script === 'literature_search.py') {
        assert.ok(args.includes('--resume'));
        assert.ok(args.includes('--scrape-current'));
        assert.ok(!args.includes('--defer-source'), 'ordinary continue retries the pending source');
        const state = readJson(path.join(dir, 'discovery-state.json'));
        state.deferred_sources = [];
        state.pending_source = null;
        writeJson(path.join(dir, 'discovery-state.json'), state);
        writeJson(path.join(dir, 'candidates.json'), { count: 60, discovery_complete: true,
          batches: [{ status: 'complete' }], records: [] });
        emit({ type: 'result', stage: 'discover', count: 60, deferred_sources: [] });
      } else {
        assert.equal(script, 'literature_dedupe.py'); dedupeCalls++;
        emit({ type: 'result', stage: 'dedupe', count: 60 });
      }
    };
    connector.advance(ID);
    job = await settled(connector);
    assert.equal(job.status, 'completed');
    assert.equal(dedupeCalls, 1);
    assert.deepEqual(job.deferredSources, []);
    assert.equal(job.id, ID);

    const invalids = [
      { value: 'arxiv' }, { value: 'cnki' }, { value: null }, { value: '' },
      { value: SOURCE, mutate: state => { state.status = 'running'; } },
      { value: SOURCE, mutate: state => { state.resumeStage = 'dedupe'; } },
      { value: SOURCE, mutate: state => { state.status = 'completed'; } },
      { value: SOURCE, checkpoint: state => { state.pending_source = 'cnki'; } },
      { value: SOURCE, checkpoint: state => { state.sources[SOURCE].status = 'error'; } },
      { value: SOURCE, until: 'export' }, { value: SOURCE, until: 'discover' }
    ];
    for (const invalid of invalids) {
      fixture(root);
      if (invalid.mutate) {
        const state = readJson(path.join(dir, 'job.json')); invalid.mutate(state); writeJson(path.join(dir, 'job.json'), state);
      }
      if (invalid.checkpoint) {
        const state = readJson(path.join(dir, 'discovery-state.json')); invalid.checkpoint(state); writeJson(path.join(dir, 'discovery-state.json'), state);
      }
      const files = ['job.json', 'run_config.json', 'discovery-state.json', 'browser-tabs.json'];
      const before = files.map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
      const guarded = new LiteratureConnector(root, { prepare: async () => { throw new Error('must not execute'); } });
      assert.throws(() => guarded.advance(ID, { deferSource: invalid.value,
        ...(invalid.until ? { until: invalid.until } : {}) }), /暂缓|运行/);
      assert.deepEqual(files.map(file => fs.readFileSync(path.join(dir, file), 'utf8')), before, 'rejected defer must not mutate task files');
      assert.equal(guarded.jobs.size, 0, 'rejected defer must not load or alter a job');
    }
    fixture(root);
    let explicitRuns = 0;
    const explicit = new LiteratureConnector(root, { prepare: async () => 'fixture-python' });
    explicit.runStage = async (script, args, current, emit) => {
      explicitRuns++;
      assert.equal(script, 'literature_search.py');
      assert.equal(current.until, 'dedupe');
      assert.equal(args[args.indexOf('--defer-source') + 1], SOURCE);
      emit({ type: 'attention', stage: 'verification', source: SOURCE, reason: 'results_unrecognized', count: 30 });
    };
    explicit.advance(ID, { deferSource: SOURCE, until: 'dedupe' });
    const explicitResult = await settled(explicit);
    assert.equal(explicitRuns, 1, 'explicit unchanged boundary must remain valid');
    assert.equal(explicitResult.until, 'dedupe');
    assert.equal(explicitResult.id, ID);
    console.log('LITERATURE_DEFER_TESTS_PASS');
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-defer-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
