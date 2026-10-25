#!/usr/bin/env node
'use strict';

// Production UI actions + isolated state. No server, browser, downloads, or user jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const names = ['literatureResumeStage', 'replenishLiteratureMaterials', 'viewLiteratureMaterialsRelatedJob', 'continueLiterature', 'confirmLiteratureFields', 'autoOpenLiteratureBrowser', 'openLiteratureMaterialActionPage'];
function fn(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const original = { id: 'parent', status: 'completed', stage: 'completed', resumeStage: null, until: 'export', canReplenishMaterials: true,
  config: { query: 'frozen query', sources: ['pubmed'] }, count: 10,
  counters: { candidates: 10, fulltextFetched: 3, parameterRows: 259 },
  files: ['candidates.json', 'dedupe/dedupe.json', 'fulltext/status.json', 'extraction/result.json', 'export/parameters.xlsx'],
  stages: Object.fromEntries(['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'].map(stage => [stage, 'done'])) };
const originalBytes = JSON.stringify(original);
const child = { id: 'child', status: 'completed', stage: 'completed', resumeStage: null, until: 'fulltext', canReplenishMaterials: false,
  config: copy(original.config), files: ['candidates.json', 'dedupe/dedupe.json', 'fulltext/status.json'],
  counters: { candidates: 10, fulltextFetched: 5, parameterRows: 0 },
  materialReplenishment: { parentJobId: 'parent', candidateCount: 10, createdAt: 'fixture' } };
const draft = { query: 'edited draft that must survive', sources: ['cnki'], fieldDefinitions: [{ label: 'unsaved meaning', unit: '原文单位' }] };
const current = { literatureJob: copy(original), literatureConfig: copy(draft), literatureUntil: 'export', literatureConfigOpen: true, literatureBusy: false };
const saved = { m: { sessionId: 'keep-session', literatureJobId: 'parent', literatureSource: 'old-source' } };
const calls = [];
const context = vm.createContext({ task: () => current, saved,
  root: { LiteratureUI: { isBusy: () => false } }, render() {}, persist() {}, renderLiteratureFieldsDialog() {},
  literatureSource: () => 'new-source', literatureStageLabel: stage => stage,
  LITERATURE_STAGE_ORDER: ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'], LITERATURE_EXECUTABLE_SOURCES: ['pubmed', 'cnki'],
  sameLiteratureConfig: (left, right) => JSON.stringify(left) === JSON.stringify(right), sameLiteratureDeferralConfig: () => false,
  checkLiteratureRuntime: async sources => calls.push({ runtime: copy(sources) }),
  applyLiteratureJob: (_mod, next) => { current.literatureJob = copy(next); saved.m.literatureJobId = next.id; },
  watchLiterature: async (_id, jobId) => calls.push({ watch: jobId }),
  request: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    if (url === '/api/literature/replenish-materials') return copy(child);
    if (url === '/api/literature/job?id=parent') return copy(original);
    if (url === '/api/literature/job?id=child') return copy(child);
    if (url === '/api/literature/advance') return { ...copy(child), status: 'completed' };
    if (url === '/api/literature/material-action-page') return { opened: true };
    throw new Error('Unexpected mutation: ' + url);
  }
});
vm.runInContext(names.map(fn).join('\n') + '\nglobalThis.subject={' + names.join(',') + '};', context);

async function main() {
  const s = context.subject, mod = { id: 'm' };
  assert.equal(s.literatureResumeStage(original), null, 'Fully done tasks cannot infer a fulltext resume');
  assert.equal(s.literatureResumeStage({ status: 'completed', files: ['candidates.json'] }), 'dedupe');
  assert.equal(s.literatureResumeStage({ status: 'completed', files: ['candidates.json', 'dedupe/dedupe.json'] }), 'fulltext');
  assert.equal(s.literatureResumeStage({ status: 'completed', files: ['candidates.json', 'extraction/result.json'] }), null);
  assert.equal(s.literatureResumeStage({ ...original, stages: {}, resumeStage: 'completed' }), null);
  assert.equal(s.literatureResumeStage(child), null);
  await Promise.all([s.replenishLiteratureMaterials(mod), s.replenishLiteratureMaterials(mod)]);
  const posts = calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts, [{ url: '/api/literature/replenish-materials', method: 'POST', body: { id: 'parent' } }]);
  assert.equal(calls[0].runtime[0], 'pubmed', 'Runtime and child use frozen sources, not the edited CNKI draft');
  assert.equal(current.literatureJob.id, 'child'); assert.equal(current.literatureUntil, 'fulltext');
  assert.deepEqual(copy(current.literatureConfig), original.config);
  assert.deepEqual(copy(saved.m.literatureMaterialsParentDraft.config), draft);
  assert.equal(saved.m.sessionId, 'keep-session');
  const count = calls.length;
  await s.continueLiterature(mod, { until: 'extract' });
  assert.equal(calls.length, count, 'Completed child does not continue into extraction');
  await s.confirmLiteratureFields(mod);
  assert.equal(calls.length, count, 'Material-only child cannot confirm extraction');
  await s.viewLiteratureMaterialsRelatedJob(mod, 'parent');
  assert.equal(current.literatureJob.id, 'parent');
  assert.deepEqual(copy(current.literatureConfig), draft, 'Returning to the original preserves its edited draft');
  assert.equal(current.literatureUntil, 'export'); assert.equal(current.literatureConfigOpen, true);
  assert.equal(saved.m.literatureReadOnlyJobId, 'parent');
  const beforeReadOnly = calls.length;
  await s.continueLiterature(mod); await s.confirmLiteratureFields(mod);
  assert.equal(calls.length, beforeReadOnly, 'Original result navigation is read-only');
  await s.viewLiteratureMaterialsRelatedJob(mod, 'child');
  assert.deepEqual(copy(current.literatureConfig), original.config, 'Child keeps the original frozen query after the round trip');
  assert.equal(current.literatureUntil, 'fulltext');
  current.literatureJob.status = 'needs_attention'; current.literatureJob.resumeStage = 'fulltext'; current.literatureUntil = 'export';
  await s.continueLiterature(mod, { until: 'extract' });
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/advance').body, { id: 'child', until: 'fulltext' });
  current.literatureJob = { ...copy(child), status: 'needs_attention', resumeStage: 'fulltext', attention: { reason: 'login', source: 'cnki' } };
  await s.continueLiterature(mod, { until: 'extract', deferAccess: true });
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/advance').body, { id: 'child', until: 'fulltext', deferAccess: true });
  current.literatureJob = { ...copy(child), status: 'needs_attention', resumeStage: 'fulltext', materialAccessPolicy: 'defer',
    attention: { reason: 'deferred_materials' }, materialManualActions: [{ paperId: 'PMID-001', title: 'Blocked first article' }] };
  const beforeManual = calls.length;
  await s.continueLiterature(mod);
  await s.autoOpenLiteratureBrowser('m', current.literatureJob);
  assert.equal(calls.length, beforeManual, 'A final manual list must not automatically open pages or rerun');
  await s.openLiteratureMaterialActionPage(mod, 'not-in-list');
  assert.equal(calls.length, beforeManual, 'Only an existing manual item may open its saved official page');
  await s.openLiteratureMaterialActionPage(mod, 'PMID-001');
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/material-action-page').body, { id: 'child', paperId: 'PMID-001' });
  assert.match(current.literatureMaterialNotice, /人工登录不限时/);
  await s.continueLiterature(mod, { until: 'extract', retryDeferred: true });
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/advance').body, { id: 'child', until: 'fulltext', deferAccess: true, retryDeferred: true });
  assert.equal(JSON.stringify(original), originalBytes, 'Parent results and counts remain unchanged');
  assert.deepEqual(calls.filter(call => call.url?.includes('/job?')).map(call => call.method), ['GET', 'GET']);
  assert.ok(!calls.some(call => /search|browser|download|extract/.test(call.url || '')));
  console.log('LITERATURE_MATERIALS_REPLENISHMENT_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
