#!/usr/bin/env node
'use strict';

// Real UI functions, isolated requests and state. This does not run user tasks,
// launch a browser, contact databases, or change browser storage on the machine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const MODULE = 'module-fixture';
const mod = { id: MODULE };
const SOURCES = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'];
const RUNTIME = { protocolVersion: 1, restartRequired: false, supportedSources: SOURCES,
  browserSession: 'persistent-research-browser', instanceId: 'fixture-instance' };

function functionSource(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '(');
  assert.ok(start >= 0, 'Missing production function: ' + name);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
const FUNCTIONS = ['checkLiteratureRuntime', 'autoOpenLiteratureBrowser', 'watchLiterature', 'startLiterature',
  'continueLiterature', 'continueAvailableLiterature', 'reviewLiteratureFulltext', 'openLiteratureBrowser', 'confirmLiteratureFields', 'literatureAttentionMessage', 'literatureCompletedMessage', 'literatureProcessingBasisMessage'];
function job(overrides = {}) {
  return { id: 'original-job', status: 'needs_attention', stage: 'verification', resumeStage: 'discover', until: 'discover',
    config: { topic: 'fixture topic', query: 'fixture query', sources: ['cnki'], limit: 10,
      searchMode: 'formal', stopMode: 'end', perSourceLimit: null, targetFields: [], fieldDefinitions: [] },
    attention: { source: 'cnki', reason: 'login' }, message: '请完成机构登录', count: 20, files: ['candidates.csv'],
    events: [{ at: '2026-10-19T01:00:00.000Z', stage: 'verification', message: '请完成机构登录' }], ...overrides };
}
function harness(savedSnapshot) {
  let activeJob = job();
  let runtime = copy(RUNTIME), runtimeError = null, browserError = null, availableError = null;
  const calls = [], messages = [];
  const saved = savedSnapshot ? copy(savedSnapshot) : { [MODULE]: { literatureSource: 'fixture-source' } };
  const current = { busy: false, literatureBusy: false, literatureError: '', literatureUntil: 'discover',
    literatureJob: activeJob, literatureConfig: copy(activeJob.config), literatureConfirmDrafts: [{ key: 'value', label: '值', meaning: '报告值', unit: '原文单位', valueType: 'number' }] };
  const context = vm.createContext({
    task: () => current, saved, root: { LiteratureUI: { isBusy: () => false } }, account: { model: 'fixture-model' },
    persist() {}, render() {}, renderLiteratureFieldsDialog() {}, closeLiteratureFields() {},
    ensureLiteratureFieldDrafts: () => current.literatureConfirmDrafts,
    validatedLiteratureFields: () => copy(current.literatureConfirmDrafts), saveLiteratureFieldDrafts: () => true,
    literatureSource: () => 'fixture-source', literatureStageLabel: stage => stage, literatureDeliverableSummary: () => '',
    Store: { appendMessage: (...args) => messages.push(args) },
    applyLiteratureJob: (_mod, next) => { current.literatureJob = next; },
    request: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method: options.method || 'GET', body });
      if (url === '/api/literature/runtime') { if (runtimeError) throw runtimeError; return copy(runtime); }
      if (url === '/api/literature/browser') { if (browserError) throw browserError; return { opened: true, source: activeJob.attention?.source }; }
      if (url === '/api/literature/review-fulltext') {
        activeJob = { ...activeJob, status: 'needs_attention', stage: 'fulltext_review', resumeStage: 'fulltext',
          attention: null, message: '缓存已复核，尚未继续获取全文。', counters: { fulltextAbstract: 1 } };
        return copy(activeJob);
      }
      if (url === '/api/literature/search') {
        activeJob = job({ id: 'new-job', config: copy(body.config), status: 'completed', stage: 'completed', until: body.until, attention: null });
        return copy(activeJob);
      }
      if (url === '/api/literature/advance') {
        activeJob = { ...activeJob, status: 'completed', stage: 'completed', until: body.until, attention: null };
        return copy(activeJob);
      }
      if (url === '/api/literature/continue-available') {
        if (availableError) throw availableError;
        const parent = activeJob;
        activeJob = { ...parent, id: 'partial-processing-child', status: 'completed', stage: 'completed', until: body.until,
          resumeStage: body.until === 'dedupe' ? 'fulltext' : 'extract', attention: null, deferredOnly: false,
          processingBasis: { parentJobId: parent.id, candidateCount: parent.count, deferredSources: parent.deferredSources,
            candidateSnapshotSha256: 'fixture-sha256', createdAt: '2026-10-20T00:00:00.000Z' } };
        return copy(activeJob);
      }
      if (url.startsWith('/api/literature/job?')) return copy(activeJob);
      throw new Error('Unexpected fixture request: ' + url);
    },
    setTimeout: callback => { callback(); return 1; }, clearTimeout() {}
  });
  const configCode = source.slice(source.indexOf('  const LITERATURE_CONFIG_KEYS'), source.indexOf('  async function prepareLiterature'));
  const labelsCode = source.slice(source.indexOf('  const LITERATURE_STAGE_ORDER'), source.indexOf('  function literatureFileLabel'));
  vm.runInContext(configCode + labelsCode + '\n' + FUNCTIONS.map(functionSource).join('\n')
    + '\nglobalThis.subject = { ' + FUNCTIONS.join(', ') + ' };', context);
  return { subject: context.subject, current, saved, calls, messages,
    setRuntime(value) { runtime = value; }, setRuntimeError(error) { runtimeError = error; }, setBrowserError(error) { browserError = error; }, setAvailableError(error) { availableError = error; },
    setJob(next) { activeJob = copy(next); current.literatureJob = copy(next); current.literatureConfig = copy(next.config); current.literatureUntil = next.until; },
    count(url) { return calls.filter(call => call.url === url).length; },
    posts() { return calls.filter(call => call.method === 'POST'); }
  };
}

async function main() {
  const wosTimeout = 'Web of Science 服务端响应超时（524），已有结果保留。无需反复登录，请稍后在原任务中点击“检查并继续”。';
  const timeoutText = harness().subject.literatureAttentionMessage(job({
    attention: { source: 'web-of-science', reason: 'results_unrecognized' }, message: wosTimeout }));
  assert.equal(timeoutText, 'Web of Science 核心合集：' + wosTimeout, 'Known WOS 524 needs only its original timeout/resume guidance');
  assert.ok(!timeoutText.includes('平台专用检索浏览器') && !timeoutText.includes('普通 Edge/Chrome'), 'A server timeout must not append login instructions');
  const wosListPending = 'WOS结果页面已打开，但文献列表尚未加载。请在原页面确认文献题名出现后再检查并继续；已有候选保留。';
  const listPendingText = harness().subject.literatureAttentionMessage(job({
    attention: { source: 'web-of-science', reason: 'results_unrecognized' }, message: wosListPending }));
  assert.equal(listPendingText, 'Web of Science 核心合集：' + wosListPending, 'A pending WOS result list must show its precise page-check instruction');
  assert.ok(!listPendingText.includes('平台专用检索浏览器') && !listPendingText.includes('普通 Edge/Chrome'), 'Pending titles must not be described as another login problem');
  for (const [sourceKey, label, message] of [
    ['cnki', '中国知网', '尚不能确认本次检索的结果页面。请查看该任务的官方页面，确认检索式和结果已加载后再继续。'],
    ['web-of-science', 'Web of Science 核心合集', 'WOS原结果页面的检索式或页码尚不能与本任务待处理页对应。请在原页面核对检索式和页码后检查并继续；原页面与已有候选保留。']
  ]) {
    const text = harness().subject.literatureAttentionMessage(job({ attention: { source: sourceKey, reason: 'results_unrecognized' }, message }));
    assert.equal(text, label + '：' + message, 'Unverified result pages retain the exact backend explanation');
    assert.ok(!text.includes('普通 Edge/Chrome') && !text.includes('请在平台专用检索浏览器'), 'Result-page consistency is not evidence of a login problem');
  }
  for (const reason of ['login', 'verification', 'access_required']) {
    const text = harness().subject.literatureAttentionMessage(job({ attention: { source: 'cnki', reason }, message: '请处理实际访问问题。' }));
    assert.ok(text.includes('请在平台专用检索浏览器') && text.includes('普通 Edge/Chrome'), 'Real authentication waits keep manual access instructions: ' + reason);
  }
  const wosLoginText = harness().subject.literatureAttentionMessage(job({
    attention: { source: 'web-of-science', reason: 'login' }, message: '请完成机构登录。' }));
  assert.ok(wosLoginText.includes('请在平台专用检索浏览器') && wosLoginText.includes('普通 Edge/Chrome'), 'Actual WOS login keeps the existing browser instructions');
  for (const message of ['请完成登录。', '请完成登录.', '请完成登录。...']) {
    const text = harness().subject.literatureAttentionMessage(job({ message }));
    assert.ok(text.includes('请完成登录。请在平台专用'));
    assert.ok(!text.includes('。。') && !text.includes('.。'), 'Appended guidance must not duplicate sentence endings');
  }
  for (const text of ['当前端口后台需要更新', '旧启动窗口', '重新打开本项目启动器', '平台专用检索浏览器', '普通 Edge/Chrome 的登录不会自动共享']) {
    assert.ok(source.includes(text), 'Runtime/login instructions should be visible: ' + text);
  }
  assert.ok(source.includes("'查看原页面' : '打开登录/检索页面'"), 'Manual open remains available after an automatic attempt');
  const old = harness(); old.setRuntimeError(new Error('404 route not found'));
  await old.subject.startLiterature(mod);
  assert.equal(old.posts().length, 0, 'Old server must not receive a new search');
  assert.match(old.current.literatureError, /当前端口后台需要更新.*启动/);
  await old.subject.continueLiterature(mod);
  assert.equal(old.posts().length, 0, 'Old server must not receive advance');
  await old.subject.openLiteratureBrowser(mod);
  assert.equal(old.posts().length, 0, 'Old server must not receive browser-open mutation');
  old.setJob(job({ stage: 'awaiting_confirmation', resumeStage: 'extract', until: 'export', attention: null }));
  await old.subject.confirmLiteratureFields(mod);
  assert.equal(old.posts().length, 0, 'Old server must not receive field confirmation');
  assert.match(old.current.literatureFieldsError, /当前端口后台需要更新/);
  assert.ok(old.current.literatureConfirmDrafts.length, 'Rejected runtime must retain field drafts');

  for (const unavailable of [null, { ...RUNTIME, protocolVersion: 0 }, { ...RUNTIME, restartRequired: true },
    { ...RUNTIME, supportedSources: ['pubmed'] }, { ...RUNTIME, browserSession: 'ordinary-browser' }]) {
    const rejected = harness(); rejected.setRuntime(unavailable);
    await rejected.subject.startLiterature(mod);
    assert.equal(rejected.posts().length, 0, 'Unsupported or stale runtime must block execution');
    assert.match(rejected.current.literatureError, /当前端口后台需要更新/);
  }
  const capabilities = harness(); capabilities.setRuntime({ ...RUNTIME, supportedSources: ['pubmed'] });
  await assert.rejects(() => capabilities.subject.checkLiteratureRuntime(['cnki']), /中国知网/);

  const fresh = harness(); await fresh.subject.startLiterature(mod);
  const search = fresh.calls.find(call => call.url === '/api/literature/search');
  assert.ok(search); assert.equal(fresh.calls[0].url, '/api/literature/runtime');
  assert.equal(search.body.config.stopMode, 'end'); assert.equal(search.body.config.perSourceLimit, null);
  assert.equal(search.body.until, 'discover');
  const resume = harness(); resume.current.literatureUntil = '';
  await resume.subject.continueLiterature(mod);
  const advance = resume.calls.find(call => call.url === '/api/literature/advance');
  assert.equal(resume.calls[0].url, '/api/literature/runtime');
  assert.deepEqual(advance.body, { id: 'original-job', until: 'discover' });
  assert.equal(resume.count('/api/literature/search'), 0, 'Resume must keep the original task');
  const deferred = harness(); deferred.current.literatureUntil = 'export';
  await deferred.subject.continueLiterature(mod, { deferSource: 'cnki' });
  assert.equal(deferred.calls[0].url, '/api/literature/runtime', 'Temporarily deferring a source still requires the current backend');
  assert.deepEqual(deferred.calls[1].body, { id: 'original-job', until: 'discover', deferSource: 'cnki' });
  assert.equal(deferred.count('/api/literature/search'), 0, 'Deferral never creates a replacement search');
  const oldDefer = harness(); oldDefer.setRuntimeError(new Error('old backend'));
  await oldDefer.subject.continueLiterature(mod, { deferSource: 'cnki' });
  assert.equal(oldDefer.posts().length, 0, 'Old backend cannot receive deferral commands');
  const doubleDefer = harness();
  await Promise.all([doubleDefer.subject.continueLiterature(mod, { deferSource: 'cnki' }), doubleDefer.subject.continueLiterature(mod, { deferSource: 'cnki' })]);
  assert.equal(doubleDefer.count('/api/literature/advance'), 1, 'Busy state prevents duplicate concurrent deferrals');
  const orderOnlyDefer = harness();
  const originalOrderJob = job({ attention: { source: 'web-of-science', reason: 'results_unrecognized' },
    config: { ...job().config, sources: ['web-of-science', 'cnki', 'pubmed'] } });
  orderOnlyDefer.setJob(originalOrderJob);
  orderOnlyDefer.current.literatureConfig.sources = ['cnki', 'pubmed', 'web-of-science'];
  await orderOnlyDefer.subject.continueLiterature(mod, { deferSource: 'web-of-science' });
  assert.equal(orderOnlyDefer.calls[0].url, '/api/literature/runtime');
  assert.deepEqual(orderOnlyDefer.calls[1].body, { id: originalOrderJob.id, until: 'discover', deferSource: 'web-of-science' });
  assert.deepEqual(copy(orderOnlyDefer.current.literatureConfig), originalOrderJob.config);
  const partialParent = job({ deferredOnly: true, deferredSources: ['cnki'], count: 50 });
  const partialParentBytes = JSON.stringify(partialParent);
  const available = harness(); available.setJob(partialParent);
  await available.subject.continueAvailableLiterature(mod);
  assert.equal(available.calls[0].url, '/api/literature/runtime');
  assert.deepEqual(available.calls[1], { url: '/api/literature/continue-available', method: 'POST', body: { id: partialParent.id, until: 'dedupe' } });
  assert.equal(available.current.literatureJob.id, 'partial-processing-child');
  assert.equal(available.current.literatureJob.processingBasis.parentJobId, partialParent.id);
  assert.equal(available.current.literatureUntil, 'dedupe', 'Discover selection explicitly starts the new snapshot at dedupe');
  assert.equal(JSON.stringify(partialParent), partialParentBytes, 'Starting a child cannot edit the original job');
  assert.equal(available.count('/api/literature/search'), 0); assert.equal(available.count('/api/literature/advance'), 0);
  assert.ok(available.messages.some(args => String(args[1]).includes('现有50条候选') && String(args[1]).includes('待补检来源：中国知网')
    && String(args[1]).includes('当前快照不代表全部来源已检索完成')), 'Completion messages retain incomplete-search provenance without claiming a deferred source has no records');
  const higher = harness(); higher.setJob(partialParent); higher.current.literatureUntil = 'validate';
  await higher.subject.continueAvailableLiterature(mod);
  assert.equal(higher.calls[1].body.until, 'validate', 'Higher explicitly selected processing boundaries are retained');
  for (const invalid of [{ deferredOnly: false }, { count: 0 }, { deletedAt: 'deleted' }, { status: 'running' }]) {
    const rejected = harness(); rejected.setJob({ ...partialParent, ...invalid });
    await rejected.subject.continueAvailableLiterature(mod); assert.equal(rejected.calls.length, 0);
  }
  const changedPartial = harness(); changedPartial.setJob(partialParent); changedPartial.current.literatureConfig.query = 'new scientific rule';
  await changedPartial.subject.continueAvailableLiterature(mod); assert.equal(changedPartial.calls.length, 0);
  const failedPartial = harness(); failedPartial.setJob(partialParent); failedPartial.setAvailableError(new Error('fixture snapshot rejected'));
  await failedPartial.subject.continueAvailableLiterature(mod);
  assert.equal(failedPartial.current.literatureJob.id, partialParent.id); assert.match(failedPartial.current.literatureError, /fixture snapshot rejected/);
  const oldPartial = harness(); oldPartial.setJob(partialParent); oldPartial.setRuntimeError(new Error('old backend'));
  await oldPartial.subject.continueAvailableLiterature(mod); assert.equal(oldPartial.posts().length, 0);
  const duplicatePartial = harness(); duplicatePartial.setJob(partialParent);
  await Promise.all([duplicatePartial.subject.continueAvailableLiterature(mod), duplicatePartial.subject.continueAvailableLiterature(mod)]);
  assert.equal(duplicatePartial.count('/api/literature/continue-available'), 1, 'Repeated clicks cannot create duplicate child runs');
  const confirm = harness(); confirm.setJob(job({ stage: 'awaiting_confirmation', resumeStage: 'extract', until: 'validate', attention: null }));
  await confirm.subject.confirmLiteratureFields(mod);
  assert.equal(confirm.calls[0].url, '/api/literature/runtime');
  assert.equal(confirm.calls[1].url, '/api/literature/advance');
  assert.equal(confirm.calls[1].body.id, 'original-job'); assert.equal(confirm.calls[1].body.until, 'validate');

  // Watching existing jobs stays available even if runtime does not support a
  // new execution; genuine auth waits trigger one checked browser request.
  const waiting = harness();
  await waiting.subject.watchLiterature(MODULE, 'original-job');
  assert.equal(waiting.count('/api/literature/browser'), 1);
  assert.equal(waiting.count('/api/literature/advance'), 0, 'Opening a login page never resumes the pipeline automatically');
  assert.equal(waiting.count('/api/literature/search'), 0);
  assert.ok(waiting.saved[MODULE].literatureAutoOpenStamp);
  assert.match(waiting.current.literatureAutoOpenNotice, /平台专用检索浏览器/);
  await waiting.subject.watchLiterature(MODULE, 'original-job');
  assert.equal(waiting.count('/api/literature/browser'), 1, 'Repeated polls cannot reopen the same wait');
  const refreshed = harness(waiting.saved);
  await refreshed.subject.watchLiterature(MODULE, 'original-job');
  assert.equal(refreshed.count('/api/literature/browser'), 0, 'Refresh cannot reopen the same waiting round');
  await refreshed.subject.openLiteratureBrowser(mod);
  assert.equal(refreshed.count('/api/literature/browser'), 1, 'Manual open can retry after refresh or an automatic attempt');
  assert.deepEqual(refreshed.posts()[0].body, { id: 'original-job' }, 'Browser operation passes only the original id');
  assert.equal(refreshed.count('/api/literature/advance'), 0);
  waiting.setJob(job({ events: [{ at: '2026-10-19T01:01:00.000Z', stage: 'verification', message: '请完成机构登录' }] }));
  await waiting.subject.watchLiterature(MODULE, 'original-job');
  assert.equal(waiting.count('/api/literature/browser'), 2, 'A later real waiting round may open once again');

  const parallel = harness();
  await Promise.all([parallel.subject.autoOpenLiteratureBrowser(MODULE, job()), parallel.subject.autoOpenLiteratureBrowser(MODULE, job())]);
  assert.equal(parallel.count('/api/literature/browser'), 1, 'Concurrent watchers cannot duplicate login windows');
  for (const reason of ['login', 'verification', 'access_required']) {
    const auth = harness(); auth.setJob(job({ attention: { source: 'cnki', reason } }));
    await auth.subject.watchLiterature(MODULE, 'original-job');
    assert.equal(auth.count('/api/literature/browser'), 1, 'Auth-related wait opens once: ' + reason);
  }
  const failedOpen = harness(); failedOpen.setBrowserError(new Error('fixture browser unavailable'));
  await failedOpen.subject.watchLiterature(MODULE, 'original-job');
  assert.match(failedOpen.current.literatureAutoOpenNotice, /未能自动打开.*打开登录\/检索页面/);
  await failedOpen.subject.watchLiterature(MODULE, 'original-job');
  assert.equal(failedOpen.count('/api/literature/browser'), 1, 'Automatic failures do not create a refresh loop');
  failedOpen.setBrowserError(null); await failedOpen.subject.openLiteratureBrowser(mod);
  assert.equal(failedOpen.count('/api/literature/browser'), 2);
  assert.match(failedOpen.current.literatureAutoOpenNotice, /已请求打开/);

  for (const nonAuth of [job({ attention: null, stage: 'interrupted', message: '网络暂停' }),
    job({ deferredOnly: true, deferredSources: ['cnki'] }),
    job({ attention: { source: 'cnki', reason: 'results_unrecognized' } }),
    job({ attention: { source: 'unknown', reason: 'login' } }),
    job({ stage: 'awaiting_confirmation', resumeStage: 'extract', attention: { source: 'cnki', reason: 'login' } })]) {
    const noPopup = harness(); noPopup.setJob(nonAuth); noPopup.setRuntimeError(new Error('old backend'));
    await noPopup.subject.watchLiterature(MODULE, nonAuth.id);
    assert.equal(noPopup.count('/api/literature/browser'), 0, 'Generic/field/unknown waits cannot auto-open a login page');
    assert.equal(noPopup.count('/api/literature/runtime'), 0, 'Read-only job viewing is not gated by a runtime check');
    assert.ok(noPopup.messages.length, 'Read-only watch still reports task status');
  }
  const review = harness(); review.setJob(job({ status: 'cancelled', resumeStage: null, stage: 'cancelled', canReviewFulltext: true }));
  await review.subject.reviewLiteratureFulltext(mod);
  assert.deepEqual(review.posts().map(call => call.url), ['/api/literature/review-fulltext']);
  assert.deepEqual(review.posts()[0].body, { id: 'original-job' });
  assert.equal(review.current.literatureJob.resumeStage, 'fulltext');
  assert.ok(review.messages.some(args => String(args[1]).includes('尚未继续获取全文')));
  review.current.literatureUntil = 'export';
  await review.subject.continueLiterature(mod, { until: 'fulltext' });
  assert.equal(review.posts().find(call => call.url === '/api/literature/advance').body.until, 'fulltext', 'The explicit fulltext button cannot advance into extraction');
  const fulltextError = job({ status: 'needs_attention', resumeStage: 'fulltext', attention: { source: 'cnki', reason: 'login' }, message: '知网页面404；已有材料保留' });
  assert.equal(review.subject.literatureAttentionMessage(fulltextError), fulltextError.message, 'Fulltext errors retain their exact reason without a generic login instruction');
  console.log('LITERATURE_RUNTIME_UI_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
