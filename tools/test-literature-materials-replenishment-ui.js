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

function renderManualActions(materialManualActions, status = 'needs_attention') {
  const start = source.indexOf('    const manualActions = Array.isArray(job?.materialManualActions)');
  const end = source.indexOf('    if (replenishing && Array.isArray(job.materialSkippedActions)', start);
  assert.ok(start >= 0 && end > start);
  const node = (tag, text) => ({ tag, text: text || '', children: [], attributes: {}, append(...children) { this.children.push(...children); }, setAttribute(key, value) { this.attributes[key] = value; } });
  const box = node('div');
  const rendering = vm.createContext({ node, box, replenishing: true, job: { status, materialManualActions },
    t: {}, root: { LiteratureUI: { isBusy: () => false } }, mod: { id: 'm' }, openLiteratureMaterialActionPage() {}, continueLiterature() {} });
  vm.runInContext(source.slice(start, end), rendering);
  const elements = [];
  function walk(element) { elements.push(element); element.children.forEach(walk); }
  walk(box);
  const text = elements.map(element => element.text).join('\n');
  return { elements, text };
}

function checkNotReadyRendering() {
  const { elements, text } = renderManualActions([
    { paperId: 'PMID-LOADING', title: 'Slow page', reason: 'page_not_ready', status: 'needs_attention', mainPdfMissing: null,
      supplements: { checkStatus: 'page_not_ready', missing: [], pending: ['Observed table.xlsx'] } }
  ]);
  assert.match(text, /正文PDF尚未核实/);
  assert.match(text, /页面尚未就绪，保留后稍后检查/);
  assert.match(text, /待核对附件：Observed table.xlsx/);
  assert.doesNotMatch(text, /正文PDF待补|；待补：/);
  assert.ok(elements.some(element => element.tag === 'button' && element.text === '查看保留的原页面'));
}

function checkVerificationRendering() {
  const actions = [{ paperId: 'PMID-004', title: 'Article whose PDF triggered verification', reason: 'verification',
    status: 'needs_attention', mainPdfMissing: true, supplements: { checkStatus: 'unverified' } }];
  const live = renderManualActions(actions, 'running');
  assert.match(live.text, /PMID-004/);
  assert.match(live.text, /需要手动完成验证码/);
  assert.match(live.text, /原页面手动完成验证/);
  assert.match(live.text, /人工等待不限时/);
  assert.match(live.text, /本轮继续处理其他文献/);
  assert.doesNotMatch(live.text, /原因：verification/);
  assert.ok(live.elements.some(element => element.tag === 'section' && element.attributes['aria-live'] === 'polite'));
  assert.ok(live.elements.some(element => element.tag === 'button' && element.text === '查看原页面并手动验证' && element.disabled));
  assert.ok(!live.elements.some(element => element.tag === 'button' && element.text === '我已处理，重新检查待处理文献'), 'do not start a concurrent retry');
  const paused = renderManualActions(actions);
  assert.ok(paused.elements.some(element => element.tag === 'button' && element.text === '查看原页面并手动验证' && !element.disabled));
  assert.ok(paused.elements.some(element => element.tag === 'button' && element.text === '我已处理，重新检查待处理文献'));
}

function checkSkippedMaterialRetryRendering() {
  const start = source.indexOf('    if (replenishing && Array.isArray(job.materialSkippedActions)');
  const end = source.indexOf('    if (!readOnlyResults && job?.status', start);
  assert.ok(start >= 0 && end > start);
  for (const state of [{}, { status: 'running' }, { readOnly: true }, { busy: true }, { literatureBusy: true }, { globallyBusy: true }]) {
    const node = (tag, text) => ({ tag, text: text || '', children: [], append(...children) { this.children.push(...children); }, setAttribute() {} });
    const box = node('div'), actions = [];
    const rendering = vm.createContext({ node, box, replenishing: true, readOnlyResults: !!state.readOnly,
      job: { status: state.status || 'completed', id: 'child', materialSkippedActions: [
        { paperId: 'PMID-008', title: 'A paper with legacy uncertain records', status: 'skipped', reason: 'supplements_incomplete',
          mainPdfMissing: false, supplements: { checkStatus: 'unknown', missing: ['Author navigation link', 'Reference link'] } }
      ] }, t: { busy: !!state.busy, literatureBusy: !!state.literatureBusy },
      root: { LiteratureUI: { isBusy: () => !!state.globallyBusy } }, mod: { id: 'm' },
      continueLiterature: (_mod, options) => actions.push(copy(options)) });
    vm.runInContext(source.slice(start, end), rendering);
    const elements = [];
    function walk(element) { elements.push(element); element.children.forEach(walk); }
    walk(box);
    const text = elements.map(element => element.text).join('\n');
    assert.match(text, /不代表附件不存在/);
    assert.match(text, /待核查记录：Author navigation link、Reference link/);
    assert.doesNotMatch(text, /已确认无法获取|缺补充材料/);
    assert.match(text, /已保存的文件不会重复下载/);
    const retry = elements.find(element => element.tag === 'button' && element.text === '重新核查这些材料');
    assert.ok(retry);
    assert.equal(!!retry.disabled, Object.keys(state).length > 0);
    assert.equal(actions.length, 0, 'Rendering never starts a material retry');
    if (!retry.disabled) {
      retry.onclick();
      assert.deepEqual(actions, [{ until: 'fulltext', deferAccess: true, retrySkipped: true }]);
    }
  }
}

async function main() {
  checkNotReadyRendering();
  checkVerificationRendering();
  checkSkippedMaterialRetryRendering();
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
    attention: { reason: 'deferred_materials' }, materialManualActions: [{ paperId: 'PMID-001', title: 'Blocked first article', status: 'needs_attention', reason: 'login' }] };
  const beforeManual = calls.length;
  await s.continueLiterature(mod);
  await s.autoOpenLiteratureBrowser('m', current.literatureJob);
  assert.equal(calls.length, beforeManual, 'A final manual list must not automatically open pages or rerun');
  await s.openLiteratureMaterialActionPage(mod, 'not-in-list');
  assert.equal(calls.length, beforeManual, 'Only an existing manual item may open its saved official page');
  current.literatureJob.materialManualActions.push({ paperId: 'PMID-SKIPPED', status: 'skipped', reason: 'not_found' });
  await s.openLiteratureMaterialActionPage(mod, 'PMID-SKIPPED');
  assert.equal(calls.length, beforeManual, 'A stale skipped entry cannot open an auth handling page');
  current.literatureJob.materialManualActions.push({ paperId: 'PMID-TIMEOUT', status: 'needs_attention', reason: 'timeout' });
  await s.openLiteratureMaterialActionPage(mod, 'PMID-TIMEOUT');
  assert.equal(calls.length, beforeManual, 'A legacy timeout is not an auth action');
  await s.openLiteratureMaterialActionPage(mod, 'PMID-001');
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/material-action-page').body, { id: 'child', paperId: 'PMID-001' });
  assert.match(current.literatureMaterialNotice, /人工登录不限时/);
  current.literatureJob.materialManualActions.push({ paperId: 'PMID-LOADING', status: 'needs_attention', reason: 'page_not_ready', mainPdfMissing: null });
  const beforeLoading = calls.length;
  await s.autoOpenLiteratureBrowser('m', current.literatureJob);
  assert.equal(calls.length, beforeLoading, 'A not-ready page is never automatically reopened or retried');
  await s.openLiteratureMaterialActionPage(mod, 'PMID-LOADING');
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/material-action-page').body, { id: 'child', paperId: 'PMID-LOADING' });
  assert.match(current.literatureMaterialNotice, /页面尚未就绪，保留后稍后检查/);
  assert.doesNotMatch(current.literatureMaterialNotice, /登录/);
  current.literatureJob.materialManualActions.push({ paperId: 'PMID-VERIFY', status: 'needs_attention', reason: 'verification' });
  await s.openLiteratureMaterialActionPage(mod, 'PMID-VERIFY');
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/material-action-page').body, { id: 'child', paperId: 'PMID-VERIFY' });
  assert.match(current.literatureMaterialNotice, /请手动完成验证码/);
  assert.match(current.literatureMaterialNotice, /人工验证不限时/);
  assert.doesNotMatch(current.literatureMaterialNotice, /登录/);
  const beforeRunning = calls.length;
  current.literatureJob.status = 'running';
  await s.openLiteratureMaterialActionPage(mod, 'PMID-VERIFY');
  assert.equal(calls.length, beforeRunning, 'A running batch does not reopen the verification window');
  current.literatureJob.status = 'needs_attention';
  await s.continueLiterature(mod, { until: 'extract', retryDeferred: true });
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/advance').body, { id: 'child', until: 'fulltext', deferAccess: true, retryDeferred: true });
  const completedWithSkipped = { ...copy(child), materialAccessPolicy: 'defer', materialSkippedActions: [
    { paperId: 'PMID-008', title: 'Supplement state not yet confirmed', status: 'skipped', reason: 'supplements_incomplete' }
  ] };
  current.literatureJob = copy(completedWithSkipped);
  const beforeDefaultCompleted = calls.length;
  await s.continueLiterature(mod, { until: 'extract' });
  assert.equal(calls.length, beforeDefaultCompleted, 'A completed material child does not retry without an explicit action');
  await s.continueLiterature(mod, { until: 'extract', deferAccess: true, retrySkipped: true });
  assert.deepEqual(calls.findLast(call => call.url === '/api/literature/advance').body,
    { id: 'child', until: 'fulltext', deferAccess: true, retrySkipped: true });
  assert.equal(s.literatureResumeStage(completedWithSkipped), null, 'Ordinary continuation remains unavailable for completed jobs');
  for (const invalid of [{ ...copy(child), materialSkippedActions: [] },
    { ...copy(child), materialSkippedActions: [{ paperId: 'PMID-008', status: 'needs_attention', reason: 'login' }] },
    { ...copy(completedWithSkipped), status: 'running' },
    { ...copy(original), materialSkippedActions: copy(completedWithSkipped.materialSkippedActions) }]) {
    current.literatureJob = invalid;
    const before = calls.length;
    await s.continueLiterature(mod, { until: 'fulltext', deferAccess: true, retrySkipped: true });
    assert.equal(calls.length, before, 'No empty, stale, running or original result may retry skipped materials');
  }
  current.literatureJob = copy(completedWithSkipped);
  saved.m.literatureReadOnlyJobId = 'child';
  const beforeReadOnlyRetry = calls.length;
  await s.continueLiterature(mod, { until: 'fulltext', deferAccess: true, retrySkipped: true });
  assert.equal(calls.length, beforeReadOnlyRetry, 'Read-only results cannot trigger a material retry');
  delete saved.m.literatureReadOnlyJobId;
  assert.equal(JSON.stringify(original), originalBytes, 'Parent results and counts remain unchanged');
  assert.deepEqual(calls.filter(call => call.url?.includes('/job?')).map(call => call.method), ['GET', 'GET']);
  assert.ok(!calls.some(call => /search|browser|download|extract/.test(call.url || '')));
  console.log('LITERATURE_MATERIALS_REPLENISHMENT_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
