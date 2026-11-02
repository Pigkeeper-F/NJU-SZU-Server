#!/usr/bin/env node
'use strict';
// Offline production UI tests. All fetches, storage and model jobs are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const MODULE = 'fixture-module', SESSION = 'fixture-session', JOB = 'accepted-prepare-fixture', KEY = 'research_codex_tasks_v1';
function fn(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '('); assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const configCode = source.slice(source.indexOf('  const LITERATURE_CONFIG_KEYS'), source.indexOf('  async function prepareLiterature'));
function initialClient() {
  const config = { topic: 'Original topic', query: 'original query', sources: ['pubmed'], inclusion: ['Original complete scientific rule'], targetFields: ['Reported value'], searchMode: 'formal', stopMode: 'end', perSourceLimit: null };
  return { sessionId: SESSION, literatureConfig: config, literatureUntil: 'discover', literatureSource: 'source-workspace-a',
    literatureRuleReviewId: 'original-review', literatureRuleReview: { id: 'original-review', revision: 4, ready: true, config: copy(config), history: [{ action: 'confirm' }] }, literatureReviewAppliedRevision: 4 };
}
function harness(rawClient) {
  let workspaceId = 'workspace-a', projectId = 'project-fixture', storageFailure = false, workspaceFailure = false;
  const clients = new Map([[workspaceId, copy(rawClient || initialClient())]]), taskSnapshots = new Map(), bodies = [], calls = [], snapshots = [], reviewOpens = [];
  const storage = new Map([[KEY, JSON.stringify({ [MODULE]: copy(clients.get(workspaceId)) })]]);
  let t, getMode = 'network', submitMode = 'accepted', deferredGet = null, deferredPost = null, deferredSession = null, deferredRuntime = null, returnedJobId = JOB, replyTextOverride = null;
  const mod = { id: MODULE, messages: [{ role: 'user', text: 'All confirmed scientific rules' }] };
  let storeMod = copy(mod);
  function makeTask(client) { return { literatureConfig: copy(client.literatureConfig), literatureRuleReview: copy(client.literatureRuleReview), literatureUntil: client.literatureUntil || 'discover',
    literaturePreparePending: copy(client.literaturePreparePending || null), literatureBusy: false, busy: false, model: 'fixture-model', literatureError: '' }; }
  t = makeTask(clients.get(workspaceId));
  const manager = { active: () => ({ id: workspaceId }), saveActive: () => {
    if (workspaceFailure) return { ok: false, error: 'fixture workspace quota' };
    const client = copy(context.saved[MODULE]); client.literaturePreparePending = copy(t.literaturePreparePending || null);
    clients.set(workspaceId, client); taskSnapshots.set(workspaceId, copy(t)); snapshots.push({ workspaceId, client }); return { ok: true };
  } };
  const completed = () => ({ id: returnedJobId, sessionId: SESSION, status: 'completed', text: replyTextOverride ?? JSON.stringify({ ...initialClient().literatureConfig, query: 'updated candidate query' }) });
  async function fakeFetch(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body }); if (body) bodies.push(body);
    if (url === '/api/literature/runtime') return deferredRuntime || { ok: true, json: async () => ({ busy: false, restartRequired: false }) };
    if (url === '/api/literature/prepare') {
      if (deferredPost) return deferredPost;
      if (submitMode === 'network') throw new TypeError('Failed to fetch');
      if (submitMode === 'http') return { ok: false, status: 400, json: async () => ({ error: 'Invalid scientific configuration', code: 'CONFIG_FIXTURE' }) };
      if (submitMode === 'missing-id') return { ok: true, json: async () => ({ status: 'running' }) };
      return { ok: true, json: async () => ({ id: JOB, sessionId: SESSION, status: 'running' }) };
    }
    if (url.startsWith('/api/codex/job?id=')) {
      if (deferredGet) return deferredGet;
      if (getMode === 'network') throw new TypeError('Failed to fetch');
      if (getMode === 'missing') return { ok: false, status: 400, json: async () => ({ error: '运行记录不存在（服务可能已重启）' }) };
      if (getMode === 'failed') return { ok: true, json: async () => ({ id: JOB, sessionId: SESSION, status: 'failed', error: 'Fixture model failed' }) };
      if (getMode === 'routing-failed') return { ok: true, json: async () => ({ id: JOB, sessionId: SESSION, status: 'failed', error: 'workspace routing discovery failed' }) };
      return { ok: true, json: async () => completed() };
    }
    throw new Error('Unexpected fixture route ' + url);
  }
  const context = vm.createContext({ key: KEY, saved: { [MODULE]: copy(clients.get(workspaceId)) }, task: () => t, fetch: fakeFetch,
    root: { TaskManager: { currentTaskId: () => projectId } }, account: { model: 'fixture-model' }, literatureWorkspaceManager: () => manager,
    Store: { getState: () => ({ modules: [copy(storeMod)], activeModuleId: MODULE }) },
    literatureSource: () => 'source-' + workspaceId, session: async () => deferredSession || context.saved[MODULE].sessionId, render() {}, persist() {},
    openLiteratureRuleReview: async (mod, options) => reviewOpens.push({ config: copy(t.literatureConfig), mod: copy(mod), options }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageFailure) throw new Error('Fixture storage full'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: callback => { callback(); return 1; }, Date, console });
  vm.runInContext(fn('request') + '\n' + fn('commitLiteratureRevision') + '\n' + configCode + '\n' + fn('prepareLiterature')
    + '\n' + fn('prepareLiteratureAndReview') + '\nglobalThis.subject={request,prepareLiterature,prepareLiteratureAndReview,checkLiteraturePrepareProgress,endLiteraturePreparation,checkLiteraturePrepareConnection};', context);
  return { subject: context.subject, mod, calls, bodies, snapshots, clients, storage, completed, reviewOpens, get current() { return t; }, get saved() { return context.saved[MODULE]; },
    setGet: value => { getMode = value; }, setSubmit: value => { submitMode = value; }, setStorageFailure: value => { storageFailure = value; }, setWorkspaceFailure: value => { workspaceFailure = value; },
    setReplyText: value => { replyTextOverride = value; },
    deferGet: value => { deferredGet = value; }, deferPost: value => { deferredPost = value; }, deferSession: value => { deferredSession = value; }, deferRuntime: value => { deferredRuntime = value; },
    setSession: value => { context.saved[MODULE].sessionId = value; }, setProject: value => { projectId = value; }, setJobId: value => { returnedJobId = value; },
    appendStoreUser: text => { storeMod = { ...storeMod, messages: [...storeMod.messages, { role: 'user', text }] }; },
    setApprovedDoc: content => { storeMod = { ...storeMod, doc: { status: 'approved', content } }; },
    switchWorkspace(id) {
      clients.set(workspaceId, copy(context.saved[MODULE])); taskSnapshots.set(workspaceId, copy(t)); workspaceId = id;
      if (!clients.has(id)) { const client = initialClient(); client.sessionId = 'other-session'; client.literatureSource = 'source-' + id; clients.set(id, client); }
      context.saved = { [MODULE]: copy(clients.get(id)) }; t = taskSnapshots.has(id) ? copy(taskSnapshots.get(id)) : makeTask(context.saved[MODULE]);
      t.literatureBusy = false;
    } };
}
const submits = h => h.calls.filter(call => call.url === '/api/literature/prepare').length;
function originalPreserved(h) {
  assert.deepEqual(copy(h.current.literatureConfig), initialClient().literatureConfig);
  assert.equal(h.current.literatureRuleReview.ready, true); assert.equal(h.saved.literatureReviewAppliedRevision, 4);
}
async function main() {
  const scientificClient = initialClient(); Object.assign(scientificClient.literatureConfig, { sources: ['web-of-science', 'scopus'], publicationYearFrom: 2000, publicationYearTo: 2026,
    batch: { size: 17, maxBatches: 3 }, limits: { discover: 86400 }, sourceQueries: { 'web-of-science': 'unchanged source', scopus: 'old scopus' } });
  const patchFlow = harness(scientificClient); patchFlow.setGet('completed'); patchFlow.setReplyText(JSON.stringify({ query: 'new external exposure query', sourceQueries: { scopus: 'new scopus query' } }));
  await patchFlow.subject.prepareLiteratureAndReview(patchFlow.mod);
  assert.equal(patchFlow.reviewOpens.length, 1); const actualPatch = patchFlow.current.literatureConfig;
  assert.equal(actualPatch.publicationYearFrom, 2000); assert.equal(actualPatch.publicationYearTo, 2026); assert.deepEqual(copy(actualPatch.sources), scientificClient.literatureConfig.sources);
  assert.deepEqual(copy(actualPatch.batch), scientificClient.literatureConfig.batch); assert.deepEqual(copy(actualPatch.limits), scientificClient.literatureConfig.limits);
  assert.equal(actualPatch.searchMode, 'formal'); assert.equal(actualPatch.stopMode, 'end'); assert.equal(actualPatch.sourceQueries['web-of-science'], 'unchanged source');
  assert.equal(actualPatch.sourceQueries.scopus, 'new scopus query'); assert.equal(actualPatch.query, 'new external exposure query');
  const invalidReply = harness(); invalidReply.setGet('completed'); invalidReply.setReplyText(JSON.stringify({ sources: 'pubmed', query: 'must not apply' }));
  await invalidReply.subject.prepareLiterature(invalidReply.mod);
  assert.equal(invalidReply.saved.literaturePreparePending.status, 'invalid_result');
  assert.equal(invalidReply.saved.literaturePreparePending.resultSnapshot.text, invalidReply.completed().text, 'Rejected reply is saved intact before parsing'); originalPreserved(invalidReply);
  const retryClient = copy(invalidReply.saved); retryClient.literaturePreparePending.resultSnapshot.text = JSON.stringify({ ...initialClient().literatureConfig, query: 'recovered saved reply' });
  const retrySaved = harness(retryClient); retrySaved.setGet('missing');
  const reread = await retrySaved.subject.checkLiteraturePrepareProgress(retrySaved.mod, null, { retryInvalid: true });
  assert.equal(reread.ok, true); assert.equal(retrySaved.current.literatureConfig.query, 'recovered saved reply');
  assert.equal(retrySaved.calls.length, 0, 'Re-reading the saved reply needs no model call or server job');
  const legacyClient = copy(invalidReply.saved); delete legacyClient.literaturePreparePending.resultSnapshot;
  const retryLegacy = harness(legacyClient); retryLegacy.setGet('completed'); await retryLegacy.subject.checkLiteraturePrepareProgress(retryLegacy.mod, null, { retryInvalid: true });
  assert.equal(retryLegacy.current.literatureConfig.query, 'updated candidate query'); assert.equal(submits(retryLegacy), 0); assert.equal(retryLegacy.calls.length, 1);
  const combined = harness(); combined.setGet('completed'); await combined.subject.prepareLiteratureAndReview(combined.mod);
  assert.equal(combined.reviewOpens.length, 1); assert.equal(combined.reviewOpens[0].config.query, 'updated candidate query');
  assert.equal(combined.reviewOpens[0].options.draft, true); assert.equal(submits(combined), 1);
  const combinedFailure = harness(); combinedFailure.setGet('failed'); await combinedFailure.subject.prepareLiteratureAndReview(combinedFailure.mod);
  assert.equal(combinedFailure.reviewOpens.length, 0); originalPreserved(combinedFailure);
  const combinedSaveFailure = harness(); combinedSaveFailure.setGet('completed'); combinedSaveFailure.setWorkspaceFailure(true);
  await combinedSaveFailure.subject.prepareLiteratureAndReview(combinedSaveFailure.mod); assert.equal(combinedSaveFailure.reviewOpens.length, 0); originalPreserved(combinedSaveFailure);
  const metadata = harness(); metadata.setSubmit('network');
  await assert.rejects(() => metadata.subject.request('/api/literature/prepare', { method: 'POST' }), error => error.transport === true && error.endpoint === '/api/literature/prepare' && error.method === 'POST');
  metadata.setSubmit('http'); await assert.rejects(() => metadata.subject.request('/api/literature/prepare', { method: 'POST' }), error => error.status === 400 && error.code === 'CONFIG_FIXTURE' && !error.transport);
  const disconnected = harness(); await disconnected.subject.prepareLiterature(disconnected.mod);
  assert.equal(submits(disconnected), 1); assert.equal(disconnected.saved.literaturePreparePending.id, JOB);
  assert.equal(disconnected.saved.literaturePreparePending.workspaceId, 'workspace-a'); assert.equal(disconnected.saved.literaturePreparePending.sessionId, SESSION);
  assert.match(disconnected.current.literatureError, /读取整理进度失败.*本地工作台.*检查整理进度/); originalPreserved(disconnected);
  assert.ok(disconnected.snapshots.some(snapshot => snapshot.client.literaturePreparePending?.id === JOB), 'Accepted id is in the active workspace snapshot');
  await disconnected.subject.prepareLiterature(disconnected.mod); assert.equal(submits(disconnected), 1, 'Clicking the original entry checks the same accepted job, never POSTs another');
  const refreshed = harness(JSON.parse(disconnected.storage.get(KEY))[MODULE]); originalPreserved(refreshed); assert.equal(refreshed.current.literaturePreparePending.id, JOB);
  refreshed.setGet('completed'); await refreshed.subject.checkLiteraturePrepareProgress(refreshed.mod);
  assert.equal(submits(refreshed), 0, 'Refreshing and recovering an accepted job only GETs');
  assert.equal(refreshed.current.literatureConfig.query, 'updated candidate query'); assert.equal(refreshed.current.literatureRuleReview.ready, false);
  assert.equal(refreshed.saved.literatureReviewAppliedRevision, undefined); assert.equal(refreshed.saved.literaturePreparePending, undefined);
  assert.ok(refreshed.current.literatureReviewNeedsSync, 'Recovered result is still a draft requiring human review');
  const switched = harness(); await switched.subject.prepareLiterature(switched.mod); const pendingBytes = JSON.stringify(switched.saved.literaturePreparePending);
  switched.switchWorkspace('workspace-b'); assert.equal(switched.current.literaturePreparePending, null);
  await switched.subject.checkLiteraturePrepareProgress(switched.mod); assert.equal(submits(switched), 1);
  switched.switchWorkspace('workspace-a'); assert.equal(JSON.stringify(switched.saved.literaturePreparePending), pendingBytes);
  switched.setGet('completed'); await switched.subject.checkLiteraturePrepareProgress(switched.mod);
  assert.equal(switched.current.literatureConfig.query, 'updated candidate query'); assert.equal(submits(switched), 1);
  const unknown = harness(); unknown.setSubmit('network'); await unknown.subject.prepareLiterature(unknown.mod);
  assert.equal(unknown.saved.literaturePreparePending.status, 'unknown'); assert.ok(!unknown.saved.literaturePreparePending.id);
  assert.match(unknown.current.literatureError, /提交规则整理失败.*受理状态未知.*未自动重发/); originalPreserved(unknown);
  await unknown.subject.prepareLiterature(unknown.mod); assert.equal(submits(unknown), 1);
  await unknown.subject.checkLiteraturePrepareConnection(unknown.mod); assert.equal(submits(unknown), 1); assert.match(unknown.current.literatureError, /仍不能判断是否已受理/);
  const beforeAbandonCalls = unknown.calls.length; unknown.subject.endLiteraturePreparation(unknown.mod);
  assert.equal(unknown.calls.length, beforeAbandonCalls, 'Abandon only clears local waiting state; it never cancels, GETs or POSTs a backend task');
  assert.equal(unknown.saved.literaturePreparePending, undefined); originalPreserved(unknown); assert.match(unknown.current.literatureError, /未停止后台任务/);
  unknown.setSubmit('accepted'); unknown.setGet('completed'); await unknown.subject.prepareLiterature(unknown.mod); assert.equal(submits(unknown), 2, 'Only a subsequent explicit click creates a new preparation after abandoning');
  for (const kind of ['missing', 'failed']) {
    const terminal = harness(); terminal.setGet(kind); await terminal.subject.prepareLiterature(terminal.mod); originalPreserved(terminal);
    assert.ok(['unavailable', 'failed'].includes(terminal.saved.literaturePreparePending.status));
    const count = terminal.calls.length; terminal.subject.endLiteraturePreparation(terminal.mod); assert.equal(terminal.calls.length, count); originalPreserved(terminal);
  }
  const rejected = harness(); rejected.setSubmit('http'); await rejected.subject.prepareLiterature(rejected.mod);
  assert.equal(rejected.saved.literaturePreparePending, undefined); assert.match(rejected.current.literatureError, /后台已拒绝/); originalPreserved(rejected);
  const quota = harness(); quota.setStorageFailure(true); await quota.subject.prepareLiterature(quota.mod);
  assert.equal(submits(quota), 0, 'Do not submit before a recoverable pending marker can be saved'); originalPreserved(quota);
  const newConfirmation = harness(); await newConfirmation.subject.prepareLiterature(newConfirmation.mod);
  newConfirmation.current.literatureRuleReview.revision = 5; newConfirmation.saved.literatureReviewAppliedRevision = 5;
  newConfirmation.setGet('completed'); await newConfirmation.subject.checkLiteraturePrepareProgress(newConfirmation.mod);
  assert.equal(newConfirmation.current.literatureConfig.query, 'original query'); assert.equal(newConfirmation.saved.literatureReviewAppliedRevision, 5);
  assert.equal(newConfirmation.saved.literaturePreparePending.status, 'basis_changed');
  for (const change of [h => h.appendStoreUser('A newly confirmed rule from a fresh Store snapshot'), h => h.setApprovedDoc('New approved scientific rules')]) {
    const changedContext = harness(); await changedContext.subject.prepareLiterature(changedContext.mod);
    change(changedContext); changedContext.setGet('completed'); await changedContext.subject.checkLiteraturePrepareProgress(changedContext.mod);
    originalPreserved(changedContext); assert.equal(changedContext.saved.literaturePreparePending.status, 'basis_changed', 'A fresh cloned Store context must block an old preparation result');
    assert.equal(changedContext.mod.messages.length, 1, 'The clicked module remains the old clone, reproducing production Store behavior');
  }
  for (const change of [
    h => h.appendStoreUser('Discussion changed while connecting'), h => h.setApprovedDoc('Approved document changed while connecting'),
    h => { h.current.literatureConfig.query = 'new draft while connecting'; },
    h => { h.current.literatureRuleReview.revision = 6; h.saved.literatureReviewAppliedRevision = 6; },
    h => { h.current.literatureUntil = 'dedupe'; }, h => { h.current.model = 'different-model'; }
  ]) {
    const connecting = harness(); let finishConnection;
    connecting.deferSession(new Promise(resolve => { finishConnection = resolve; }));
    const preparing = connecting.subject.prepareLiterature(connecting.mod); change(connecting); finishConnection(SESSION); await preparing;
    assert.equal(submits(connecting), 0, 'Freeze messages/config/review/stage/model before awaiting session; changed input must never be POSTed');
    assert.equal(connecting.saved.literaturePreparePending, undefined); assert.match(connecting.current.literatureError, /连接会话期间.*已变化.*尚未提交/);
  }
  const wrongId = harness(); await wrongId.subject.prepareLiterature(wrongId.mod); wrongId.setGet('completed'); wrongId.setJobId('unrelated-job');
  await wrongId.subject.checkLiteraturePrepareProgress(wrongId.mod); originalPreserved(wrongId); assert.match(wrongId.current.literatureError, /运行编号.*不匹配/);
  const routing = harness(); routing.setGet('routing-failed'); await routing.subject.prepareLiterature(routing.mod);
  originalPreserved(routing); assert.match(routing.current.literatureError, /Codex 工作区连接失败.*检查连接后再整理/);
  const routingCalls = routing.calls.length; await routing.subject.checkLiteraturePrepareProgress(routing.mod);
  assert.equal(routing.calls.length, routingCalls, 'A terminal preparation does not keep GET polling the same failed job');
  const late = harness(); await late.subject.prepareLiterature(late.mod);
  let finish; late.deferGet(new Promise(resolve => { finish = resolve; })); const reading = late.subject.checkLiteraturePrepareProgress(late.mod);
  late.switchWorkspace('workspace-b'); const nextState = JSON.stringify(late.saved); late.current.literatureBusy = true;
  finish({ ok: true, json: async () => late.completed() }); await reading;
  assert.equal(JSON.stringify(late.saved), nextState); assert.equal(late.current.literatureBusy, true, 'A late result cannot clear another workspace\'s busy state');
  const changedSession = harness(); await changedSession.subject.prepareLiterature(changedSession.mod);
  let finishSession; changedSession.deferGet(new Promise(resolve => { finishSession = resolve; })); const sameTaskRead = changedSession.subject.checkLiteraturePrepareProgress(changedSession.mod);
  changedSession.setSession('replacement-session'); finishSession({ ok: true, json: async () => changedSession.completed() }); await sameTaskRead;
  assert.equal(changedSession.current.literatureConfig.query, 'original query'); assert.equal(changedSession.saved.sessionId, 'replacement-session');
  const lateConnection = harness(); lateConnection.setSubmit('network'); await lateConnection.subject.prepareLiterature(lateConnection.mod);
  let finishRuntime; lateConnection.deferRuntime(new Promise(resolve => { finishRuntime = resolve; }));
  const checkingRuntime = lateConnection.subject.checkLiteraturePrepareConnection(lateConnection.mod); lateConnection.setProject('different-project');
  lateConnection.current.literatureError = 'Current project notice'; finishRuntime({ ok: true, json: async () => ({ busy: false }) }); await checkingRuntime;
  assert.equal(lateConnection.current.literatureError, 'Current project notice', 'A late connection-only GET must respect project ownership too');
  const lateSubmission = harness(); let finishSubmission;
  lateSubmission.deferPost(new Promise(resolve => { finishSubmission = resolve; })); const submitting = lateSubmission.subject.prepareLiterature(lateSubmission.mod);
  for (let ticks = 0; ticks < 12 && !submits(lateSubmission); ticks++) await Promise.resolve();
  assert.equal(submits(lateSubmission), 1);
  lateSubmission.switchWorkspace('workspace-b'); const otherWorkspace = JSON.stringify(lateSubmission.saved);
  finishSubmission({ ok: true, json: async () => ({ id: JOB, sessionId: SESSION, status: 'running' }) }); await submitting;
  assert.equal(JSON.stringify(lateSubmission.saved), otherWorkspace, 'A late accepted submission cannot bind its job to another workspace');
  assert.ok(!disconnected.calls.some(call => /\/api\/literature\/(search|advance)/.test(call.url)), 'No test path launches literature research');
  console.log('LITERATURE_PREPARE_RECOVERY_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
