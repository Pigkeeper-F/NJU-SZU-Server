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
  'continueLiterature', 'openLiteratureBrowser', 'confirmLiteratureFields', 'literatureAttentionMessage', 'literatureCompletedMessage'];
function job(overrides = {}) {
  return { id: 'original-job', status: 'needs_attention', stage: 'verification', resumeStage: 'discover', until: 'discover',
    config: { topic: 'fixture topic', query: 'fixture query', sources: ['cnki'], limit: 10,
      searchMode: 'formal', stopMode: 'end', perSourceLimit: null, targetFields: [], fieldDefinitions: [] },
    attention: { source: 'cnki', reason: 'login' }, message: '请完成机构登录', count: 20, files: ['candidates.csv'],
    events: [{ at: '2026-10-19T01:00:00.000Z', stage: 'verification', message: '请完成机构登录' }], ...overrides };
}
function harness(savedSnapshot) {
  let activeJob = job();
  let runtime = copy(RUNTIME), runtimeError = null, browserError = null;
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
      if (url === '/api/literature/search') {
        activeJob = job({ id: 'new-job', config: copy(body.config), status: 'completed', stage: 'completed', until: body.until, attention: null });
        return copy(activeJob);
      }
      if (url === '/api/literature/advance') {
        activeJob = { ...activeJob, status: 'completed', stage: 'completed', until: body.until, attention: null };
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
    setRuntime(value) { runtime = value; }, setRuntimeError(error) { runtimeError = error; }, setBrowserError(error) { browserError = error; },
    setJob(next) { activeJob = copy(next); current.literatureJob = copy(next); current.literatureConfig = copy(next.config); current.literatureUntil = next.until; },
    count(url) { return calls.filter(call => call.url === url).length; },
    posts() { return calls.filter(call => call.method === 'POST'); }
  };
}

async function main() {
  for (const message of ['请完成登录。', '请完成登录.', '请完成登录。...']) {
    const text = harness().subject.literatureAttentionMessage(job({ message }));
    assert.ok(text.includes('请完成登录。请在平台专用'));
    assert.ok(!text.includes('。。') && !text.includes('.。'), 'Appended guidance must not duplicate sentence endings');
  }
  for (const text of ['当前端口后台需要更新', '旧启动窗口', '重新打开本项目启动器', '平台专用检索浏览器', '普通 Edge/Chrome 的登录不会自动共享']) {
    assert.ok(source.includes(text), 'Runtime/login instructions should be visible: ' + text);
  }
  assert.ok(source.includes("node('button', '打开登录/检索页面'"), 'Manual open remains available after an automatic attempt');
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
    job({ attention: { source: 'cnki', reason: 'results_unrecognized' } }),
    job({ attention: { source: 'unknown', reason: 'login' } }),
    job({ stage: 'awaiting_confirmation', resumeStage: 'extract', attention: { source: 'cnki', reason: 'login' } })]) {
    const noPopup = harness(); noPopup.setJob(nonAuth); noPopup.setRuntimeError(new Error('old backend'));
    await noPopup.subject.watchLiterature(MODULE, nonAuth.id);
    assert.equal(noPopup.count('/api/literature/browser'), 0, 'Generic/field/unknown waits cannot auto-open a login page');
    assert.equal(noPopup.count('/api/literature/runtime'), 0, 'Read-only job viewing is not gated by a runtime check');
    assert.ok(noPopup.messages.length, 'Read-only watch still reports task status');
  }
  console.log('LITERATURE_RUNTIME_UI_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
