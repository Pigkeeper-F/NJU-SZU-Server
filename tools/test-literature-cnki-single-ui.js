'use strict';

// Execute the actual single-paper handler with isolated network/state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
const start = source.indexOf('  async function retryLiteratureCnki('), end = source.indexOf('\n  }', start);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end + 4);
function harness(overrides = {}) {
  const job = { id: 'original-job', status: 'needs_attention', config: { sources: ['cnki', 'pubmed'] },
    cnkiRetryItems: [{ id: 'CNKI-007', title: '原始完整题名', status: 'unavailable', reason: '需要补充官方入口' }] };
  const state = { literatureJob: job, busy: false, literatureBusy: false, literatureError: '', ...overrides };
  const calls = [], watched = [];
  const context = vm.createContext({ task: () => state, render() {}, root: { LiteratureUI: { isBusy: () => false } },
    checkLiteratureRuntime: async sources => { calls.push({ runtime: sources }); },
    request: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ...job, status: 'running' }; },
    applyLiteratureJob: (_mod, next) => { state.literatureJob = next; }, watchLiterature: async (...args) => watched.push(args) });
  vm.runInContext(handler + '\nglobalThis.subject=retryLiteratureCnki;', context);
  return { state, calls, watched, subject: context.subject };
}
async function main() {
  const actual = harness();
  await actual.subject({ id: 'module-fixture' }, 'CNKI-007');
  assert.equal(actual.calls.length, 2);
  assert.deepEqual(actual.calls[1], { url: '/api/literature/retry-cnki', body: { id: 'original-job', paperId: 'CNKI-007' } });
  assert.equal(actual.watched[0][1], 'original-job'); assert.equal(actual.state.literatureJob.id, 'original-job');
  assert.equal(actual.state.literatureBusy, false);
  assert.ok(!actual.calls.some(call => /search|advance|continue-available/.test(call.url || '')));
  const invalid = harness(); await invalid.subject({ id: 'module-fixture' }, 'CNKI-013'); assert.equal(invalid.calls.length, 0);
  assert.match(invalid.state.literatureError, /不在当前可重试/);
  const busy = harness({ literatureBusy: true }); await busy.subject({ id: 'module-fixture' }, 'CNKI-007'); assert.equal(busy.calls.length, 0);
  const restart = harness(); restart.state.literatureJob.cnkiRetryPaperId = 'CNKI-007';
  await restart.subject({ id: 'module-fixture' }, 'CNKI-007', true);
  assert.deepEqual(restart.calls[1], { url: '/api/literature/restart-cnki', body: { id: 'original-job', paperId: 'CNKI-007' } });
  assert.equal(restart.watched[0][1], 'original-job');
  for (const patch of [{ cnkiRetryPaperId: null }, { cnkiRetryPaperId: 'CNKI-008' }, { status: 'completed', cnkiRetryPaperId: 'CNKI-007' }]) {
    const blocked = harness(); Object.assign(blocked.state.literatureJob, patch);
    await blocked.subject({ id: 'module-fixture' }, 'CNKI-007', true); assert.equal(blocked.calls.length, 0);
    assert.match(blocked.state.literatureError, /只能重新定位/);
  }
  const material = harness(); material.state.literatureJob.cnkiRetryPaperId = 'CNKI-007'; material.state.literatureJob.cnkiRetryItems[0].materials_only = true;
  await material.subject({ id: 'module-fixture' }, 'CNKI-007', true);
  assert.equal(material.calls.length, 0); assert.match(material.state.literatureError, /继续这篇材料/);
  await material.subject({ id: 'module-fixture' }, 'CNKI-007');
  assert.equal(material.calls[1].url, '/api/literature/retry-cnki');
  assert.ok(source.includes("'重试这篇知网文献'") && source.includes("'继续这篇知网文献'"));
  assert.ok(source.includes('job.cnkiRetryItems.slice(0, 100)'));
  assert.ok(source.includes('canAdvance && !job.cnkiRetryPaperId'), 'failed single-paper run must not offer a broad stage retry');
  assert.ok(source.includes('retryLiteratureCnki(mod, job.cnkiRetryPaperId)'), 'attention resume preserves the bound single-paper scope');
  assert.ok(source.includes('重新定位这篇知网文献') && source.includes('retryLiteratureCnki(mod, job.cnkiRetryPaperId, true)'));
  assert.ok(source.includes('保留原窗口，不重跑其他文献'));
  console.log('LITERATURE_CNKI_SINGLE_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
