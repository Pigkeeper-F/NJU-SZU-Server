'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteratureConnector, __internals } = require('./literature-connector');

async function settled(connector, id) {
  const deadline = Date.now() + 5000;
  while (connector.snapshot(id).status === 'running') {
    if (Date.now() > deadline) throw new Error('Login fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return connector.snapshot(id);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-source-login-'));
  try {
    let attempts = 0, opened = [];
    const config = { topic: 'fixture', query: 'broiler heat', sources: ['google-scholar', 'cnki', 'web-of-science'],
      sourceQueries: { cnki: '肉鸡 热应激', 'web-of-science': 'broiler AND "heat stress"' }, limit: 2 };
    const options = {
      prepare: async () => 'fixture-python',
      openSource: async (job, _python, source) => {
        opened.push({ id: job.id, source });
        return { opened: true, source, label: 'fixture', cookie: 'must-not-be-returned' };
      },
      search: async (job, _python, emit) => {
        attempts++;
        if (attempts > 1) { assert.equal(job.resumeCurrent, true); assert.equal(job.resumeRun, true); }
        fs.writeFileSync(path.join(job.dir, 'candidates.json'), JSON.stringify({ batches: [{ batch_index: 1 }], discovery_complete: attempts === 3, records: [{ source_key: 'google-scholar', title: 'preserved' }] }));
        fs.writeFileSync(path.join(job.dir, 'candidates.csv'), 'title\npreserved\n');
        if (attempts < 3) emit({ type: 'attention', stage: 'verification', source: attempts === 1 ? 'cnki' : 'web-of-science',
          reason: attempts === 1 ? 'login' : 'access_required', message: '请在官方页面处理后继续', count: 1, files: ['candidates.json', 'candidates.csv'] });
        else emit({ type: 'result', stage: 'discover', count: 3, files: ['candidates.json', 'candidates.csv'], message: '三来源完成' });
      }
    };
    let connector = new LiteratureConnector(root, options);
    const started = connector.start(config);
    let job = await settled(connector, started.id);
    assert.equal(job.status, 'needs_attention');
    assert.deepEqual(job.attention, { source: 'cnki', reason: 'login' });
    assert.ok(job.files.includes('candidates.csv'), 'Partial candidates must remain downloadable');
    assert.equal(__internals.detectStagedArtifacts(path.join(root, '.workbench/literature', job.id)).stages.discover, 'pending', 'Partial discovery is not complete');
    const reply = await connector.openLogin(job.id);
    assert.deepEqual(reply, { opened: true, source: 'cnki', label: '知网' });
    assert.ok(!JSON.stringify(reply).includes('cookie'));
    connector = new LiteratureConnector(root, options);
    assert.deepEqual(connector.snapshot(job.id).attention, { source: 'cnki', reason: 'login' }, 'Refresh/restart must preserve pending source');
    await connector.openLogin(job.id);
    connector.advance(job.id);
    job = await settled(connector, job.id);
    assert.equal(job.id, started.id);
    assert.equal(job.until, 'discover', 'Login resume without until must retain the reviewed execution boundary');
    assert.deepEqual(job.attention, { source: 'web-of-science', reason: 'access_required' });
    await connector.openLogin(job.id);
    assert.deepEqual(opened.map(item => item.source), ['cnki', 'cnki', 'web-of-science']);
    connector.advance(job.id, { until: 'discover' });
    job = await settled(connector, job.id);
    assert.equal(job.status, 'completed'); assert.equal(job.until, 'discover');
    assert.equal(job.resumeStage, 'dedupe'); assert.equal(job.attention, null);
    assert.equal(attempts, 3);
    await assert.rejects(connector.openLogin(job.id), /没有等待/);
    await assert.rejects(connector.openLogin('../bad'), /无效检索任务/);
    assert.throws(() => connector.advance(job.id, { until: 'discover' }), /当前待运行阶段/);
    const cancelled = new LiteratureConnector(root, { ...options, search: async (_job, _py, emit) => emit({ type: 'attention', stage: 'verification', source: 'cnki', reason: 'verification', message: '请手动验证' }) });
    const waiting = await settled(cancelled, cancelled.start(config).id);
    assert.equal(cancelled.cancel(waiting.id).status, 'cancelled', 'Waiting jobs can be stopped without deleting records');
    await assert.rejects(cancelled.openLogin(waiting.id), /没有等待/);
    console.log('LITERATURE_LOGIN_TESTS_PASS: pending source, partial results, restart, same-job resume, login guards, cancellation');
  } finally {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanxu-source-login-')) throw new Error('Unexpected test directory');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
