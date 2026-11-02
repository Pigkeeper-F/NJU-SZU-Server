'use strict';

// Isolated files and stage doubles only; no source, model, browser or real job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LiteratureConnector, STAGES } = require('./literature-connector');
const { LiteratureAuxiliary } = require('./literature-auxiliary');
const { buildConfig } = require('./literature-confirmed-plan');
const { ITEMS } = require('./literature-rule-review');
const ID = '32345678-1234-4234-8234-123456789abc';
const REVIEW = '42345678-1234-4234-8234-123456789abc';
const repository = path.resolve(__dirname, '..');
const temporaryBase = path.join(repository, '.tmp-literature-tests');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
function fixture(root, withReview = false) {
  const dir = path.join(root, '.workbench', 'literature', ID);
  fs.mkdirSync(dir, { recursive: true });
  const { config, basis } = buildConfig(repository, 'CNKI-PRODUCTION', new Date('2026-10-31T00:00:00Z'));
  write(path.join(dir, 'run_config.json'), config);
  write(path.join(dir, 'research-basis.json'), basis);
  write(path.join(dir, 'candidates.json'), { count: 2, discovery_complete: false,
    records: [{ candidate_id: 'one', title: 'One' }, { candidate_id: 'two', title: 'Two' }] });
  fs.writeFileSync(path.join(dir, 'candidates.csv'), 'candidate_id,title\none,One\ntwo,Two\n');
  write(path.join(dir, 'discovery-state.json'), { pending_source: 'cnki', deferred_sources: ['cnki'],
    sources: { cnki: { status: 'attention', next_page: 191 } } });
  write(path.join(dir, 'job.json'), { id: ID, config, status: 'needs_attention', stage: 'verification',
    resumeStage: 'discover', until: 'discover', count: 2, files: ['run_config.json', 'research-basis.json'],
    stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])), events: [], counters: {} });
  if (withReview) {
    const all = { ...config, until: 'discover' };
    write(path.join(dir, 'rule-review-confirmed.json'), { reviewId: REVIEW, revision: 1, config, until: 'discover',
      fingerprint: sha(JSON.stringify(canonical({ config, until: 'discover' }))),
      items: ITEMS.map(spec => ({ id: spec.id, groupId: spec.groupId, status: 'confirmed',
        value: Object.fromEntries(spec.keys.filter(k => Object.hasOwn(all, k)).map(k => [k, all[k]])) })) });
  }
  return dir;
}
function harness(root, screen = async () => ({ ok: true })) {
  const connector = new LiteratureConnector(root, { prepare: async () => 'mock-python', screen });
  connector.runStage = async (script, args, job, emit) => {
    assert.ok(['literature_dedupe.py', 'literature_fulltext.py'].includes(script), 'No discovery/extraction stage');
    const stage = script === 'literature_dedupe.py' ? 'dedupe' : 'fulltext';
    fs.mkdirSync(path.join(job.dir, stage), { recursive: true });
    const file = stage === 'dedupe' ? 'dedupe/dedupe.json' : 'fulltext/status.json';
    const candidates = fs.readFileSync(path.join(job.dir, 'candidates.json'));
    write(path.join(job.dir, file), stage === 'dedupe' ? { version: 1, candidate_file_sha256: sha(candidates),
      groups: JSON.parse(candidates).records.map(record => ({ canonical_id: record.candidate_id, records: [record] })) } : { items: [] });
    emit({ type: 'result', stage, count: 2, files: [file], counts: { groups: 2 } });
  };
  return connector;
}
async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Isolated fixture did not settle');
}
function bytes(dir) { return fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]); }
async function isolated(fn) {
  fs.mkdirSync(temporaryBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryBase, 'available-basis-'));
  try { await fn(root); }
  finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(temporaryBase) || !path.basename(absolute).startsWith('available-basis-')) throw new Error('Unsafe fixture path');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
async function main() {
  await isolated(async root => {
    const dir = fixture(root), parentBefore = bytes(dir);
    const connector = harness(root);
    const child = connector.continueAvailable(ID, { until: 'dedupe' });
    await waitFor(() => connector.jobs.get(child.id).status !== 'running');
    const childDir = connector.jobs.get(child.id).dir;
    assert.deepEqual(fs.readFileSync(path.join(childDir, 'research-basis.json')), fs.readFileSync(path.join(dir, 'research-basis.json')));
    assert.equal(fs.existsSync(path.join(childDir, 'rule-review-confirmed.json')), false, 'Do not invent an absent review');
    assert.ok(connector.snapshot(child.id).files.includes('research-basis.json'));
    const marker = read(path.join(childDir, 'processing-basis.json'));
    assert.equal(marker.executionBasisSha256['research-basis.json'], sha(fs.readFileSync(path.join(dir, 'research-basis.json'))));
    assert.deepEqual(bytes(dir), parentBefore);
    const auxiliary = new LiteratureAuxiliary(root, connector);
    assert.throws(() => auxiliary.job(child.id, { importing: true }), /快照已冻结/);
    assert.equal(auxiliary.job(ID, { importing: true }).id, ID, 'Parent remains available for supplementary imports');
    assert.equal(read(path.join(childDir, 'candidates.json')).discovery_complete, false);

    let entered = false;
    connector.screen = async (_job, _python, _event, signal) => {
      entered = true;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture stopped'), { code: 'SCREENING_ATTENTION' }))));
    };
    connector.advance(child.id, { until: 'fulltext' });
    await waitFor(() => entered);
    connector.cancel(child.id);
    await waitFor(() => connector.jobs.get(child.id).activeStage === null);
    const restarted = harness(root);
    assert.throws(() => restarted.advance(child.id, { until: 'fulltext' }), /已停止/);
    restarted.advance(child.id, { until: 'fulltext', resumeConfirmed: true });
    await waitFor(() => restarted.jobs.get(child.id).status !== 'running');
    assert.equal(restarted.snapshot(child.id).status, 'completed');
    assert.equal(restarted.snapshot(child.id).stages.fulltext, 'done');
    assert.deepEqual(bytes(dir), parentBefore, 'Child cancellation/resume never rewrites parent');

    fs.chmodSync(path.join(childDir, 'research-basis.json'), 0o644);
    fs.appendFileSync(path.join(childDir, 'research-basis.json'), '\n');
    assert.throws(() => restarted.advance(child.id, { until: 'extract' }), /冻结候选或执行依据无法核验/);
    assert.equal(new LiteratureConnector(root).snapshot(child.id).processingBasis, null);
    assert.throws(() => new LiteratureAuxiliary(root, new LiteratureConnector(root)).job(child.id, { importing: true }), /快照已冻结/, 'A damaged marker cannot open import access');
  });

  await isolated(async root => {
    const dir = fixture(root, true), connector = harness(root);
    const child = connector.continueAvailable(ID, { until: 'dedupe' });
    await waitFor(() => connector.jobs.get(child.id).status !== 'running');
    assert.deepEqual(fs.readFileSync(path.join(connector.jobs.get(child.id).dir, 'rule-review-confirmed.json')),
      fs.readFileSync(path.join(dir, 'rule-review-confirmed.json')), 'Preserve the original review and its original boundary verbatim');
  });

  for (const invalid of ['missing-basis', 'basis-policy', 'basis-version', 'basis-json', 'review-config', 'review-item', 'review-fingerprint']) {
    await isolated(async root => {
      const dir = fixture(root, invalid.startsWith('review-'));
      const name = invalid.startsWith('review-') ? 'rule-review-confirmed.json' : 'research-basis.json';
      const file = path.join(dir, name);
      if (invalid === 'missing-basis') fs.unlinkSync(file);
      else if (invalid === 'basis-json') fs.writeFileSync(file, '{bad json');
      else {
        const value = read(file);
        if (invalid === 'basis-policy') value.entry.screeningPolicy.text += ' changed';
        if (invalid === 'basis-version') value.bundleHash = '0'.repeat(64);
        if (invalid === 'review-config') value.config.query += ' changed';
        if (invalid === 'review-item') value.items[0].status = 'pending';
        if (invalid === 'review-fingerprint') value.fingerprint = '0'.repeat(64);
        write(file, value);
      }
      const before = bytes(dir), connector = harness(root);
      assert.throws(() => connector.continueAvailable(ID, { until: 'dedupe' }), /依据|核查/, invalid);
      assert.deepEqual(fs.readdirSync(path.dirname(dir)), [ID], 'Invalid evidence creates no child');
      assert.deepEqual(bytes(dir), before);
    });
  }
  console.log('LITERATURE_CONTINUE_AVAILABLE_FROZEN_BASIS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
