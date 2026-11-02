#!/usr/bin/env node
'use strict';
// Offline production-function tests. No actual task, model, search or storage is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const mod = { id: 'fixture-module', messages: [{ role: 'user', text: 'Confirmed scientific requirements' }] };
const JOB = '12345678-1234-4234-8234-123456789abc', REVIEW = '22345678-1234-4234-8234-123456789abc', SESSION = '32345678-1234-4234-8234-123456789abc';
const KEY = 'research_codex_tasks_v1';
function fn(name) {
  const begin = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(begin + name + '('); assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function harness(clientSnapshot) {
  const config = { topic: 'Frozen topic', query: 'original query', sources: ['pubmed'], searchMode: 'formal', stopMode: 'end', perSourceLimit: null };
  const job = { id: JOB, status: 'needs_attention', config: copy(config), until: 'discover', files: ['rule-review-confirmed.json'] };
  const review = { id: REVIEW, sessionId: SESSION, workspaceId: 'workspace-fixture', revision: 1, parentJobId: JOB, parentReviewId: 'original-review', parentRevision: 7,
    ready: true, config: copy(config), until: 'discover', source: 'fixture-source', context: { messages: copy(mod.messages), approvedDoc: '' },
    progress: { confirmed: 14, total: 14 }, items: Array.from({ length: 14 }, (_, index) => ({ id: 'item-' + index, status: 'confirmed', history: [{ action: 'confirm' }] })) };
  let current = { literatureJob: copy(job), literatureConfig: copy(config), literatureUntil: 'discover', literatureBusy: false, busy: false,
    literatureRuleReview: { id: 'original-review', revision: 7, ready: true, config: copy(config) } };
  const originalClient = { sessionId: SESSION, literatureJobId: JOB, literatureConfig: copy(config), literatureUntil: 'discover', literatureSource: 'fixture-source',
    literatureRuleReviewId: 'original-review', literatureRuleReview: copy(current.literatureRuleReview), literatureReviewAppliedRevision: 7 };
  const loadedClient = clientSnapshot ? copy(clientSnapshot) : copy(originalClient);
  if (clientSnapshot) Object.assign(current, { literatureJob: loadedClient.literatureJobId ? copy(job) : null, literatureConfig: copy(loadedClient.literatureConfig),
    literatureUntil: loadedClient.literatureUntil, literatureRuleReview: copy(loadedClient.literatureRuleReview), literatureReviewNeedsSync: loadedClient.literatureReviewNeedsSync === true });
  const storage = new Map([[KEY, JSON.stringify({ [mod.id]: loadedClient })]]), calls = [], opens = [], hydrates = [], snapshots = [];
  let projectId = 'project-fixture', workspaceId = 'workspace-fixture', storeFailure = false, storageFailure = false, apiFailure = null, deferred = null, uuid = 0;
  const manager = { active: () => ({ id: workspaceId }), saveActive: () => { snapshots.push(copy(current)); return storeFailure ? { ok: false, error: 'fixture snapshot failure' } : { ok: true }; } };
  const context = vm.createContext({ key: KEY, saved: { [mod.id]: copy(loadedClient) }, task: () => current, root: {
    TaskManager: { currentTaskId: () => projectId }, LiteratureUI: { isBusy: () => false }, LiteratureRuleReview: { close() {} },
    crypto: { randomUUID: () => '42345678-1234-4234-8234-' + String(++uuid).padStart(12, '0') } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageFailure) throw new Error('fixture quota exceeded'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    Store: { getState: () => ({ activeModuleId: mod.id, modules: [copy(mod)] }) }, literatureWorkspaceManager: () => manager, literatureSource: () => 'fixture-source',
    render() {}, session: async () => SESSION, openLiteratureRuleReview: async () => { opens.push(copy(current)); }, hydrateLiteratureWorkspace: async () => { hydrates.push(current.literatureJob.id); },
    request: async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); if (apiFailure) throw apiFailure; if (deferred) return deferred;
      return url.endsWith('/action') ? { ...copy(review), revision: 2, config: copy(body.config), until: body.until, ready: false,
        progress: { confirmed: 10, total: 14 }, items: review.items.map((item, index) => ({ ...copy(item), status: index < 4 ? 'pending' : 'confirmed' })) } : copy(review); }
  });
  vm.runInContext(['commitLiteratureRevision', 'reviseLiteratureConfiguration', 'swapLiteratureRevision'].map(fn).join('\n')
    + '\nglobalThis.subject={reviseLiteratureConfiguration,swapLiteratureRevision,getSaved:()=>saved};', context);
  return { subject: context.subject, calls, opens, hydrates, snapshots, storage, review, job, originalClient, get current() { return current; },
    setCurrent: value => { current = value; }, setProject: value => { projectId = value; }, setWorkspace: value => { workspaceId = value; },
    setStoreFailure: value => { storeFailure = value; }, setStorageFailure: value => { storageFailure = value; }, setApiFailure: value => { apiFailure = value; }, defer: value => { deferred = value; } };
}
async function main() {
  const h = harness(), originalBytes = JSON.stringify(h.job); await h.subject.reviseLiteratureConfiguration(mod);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/literature/rule-review/fork');
  assert.equal(h.calls[0].body.jobId, JOB); assert.equal(h.calls[0].body.sessionId, SESSION); assert.equal(h.calls[0].body.workspaceId, 'workspace-fixture');
  assert.equal(h.calls[0].body.source, 'fixture-source'); assert.deepEqual(h.calls[0].body.context.messages, mod.messages); assert.ok(h.calls[0].body.requestId);
  assert.equal(h.current.literatureJob, null); assert.equal(h.current.literatureRuleReview.ready, true, 'Unchanged confirmations are inherited from the server');
  assert.equal(h.subject.getSaved()[mod.id].literatureJobId, undefined); assert.equal(h.subject.getSaved()[mod.id].literatureReviewAppliedRevision, undefined);
  assert.equal(h.subject.getSaved()[mod.id].literatureRevisionParentId, JOB); assert.equal(h.subject.getSaved()[mod.id].literatureRevisionOriginal.job.id, JOB);
  assert.equal(h.opens.length, 1); assert.equal(JSON.stringify(h.job), originalBytes); assert.ok(!h.calls.some(call => /search|advance/.test(call.url)));
  h.current.literatureConfig.query = 'Revised scientific query'; h.subject.getSaved()[mod.id].literatureConfig = copy(h.current.literatureConfig);
  h.subject.swapLiteratureRevision(mod, true);
  assert.equal(h.current.literatureJob.id, JOB); assert.equal(h.current.literatureConfig.query, 'original query'); assert.deepEqual(h.hydrates, [JOB]);
  assert.equal(h.subject.getSaved()[mod.id].literatureRevisionDraft.client.literatureConfig.query, 'Revised scientific query');
  const refreshed = harness(JSON.parse(h.storage.get(KEY))[mod.id]);
  assert.equal(refreshed.current.literatureJob.id, JOB); refreshed.subject.swapLiteratureRevision(mod, false);
  assert.equal(refreshed.current.literatureJob, null); assert.equal(refreshed.current.literatureConfig.query, 'Revised scientific query');
  assert.equal(refreshed.subject.getSaved()[mod.id].literatureRuleReviewId, REVIEW); assert.equal(refreshed.calls.length, 0, 'Refresh and returning to the saved revision never start a backend operation');
  const refreshedDraft = harness(JSON.parse(refreshed.storage.get(KEY))[mod.id]);
  assert.equal(refreshedDraft.current.literatureJob, null); assert.equal(refreshedDraft.current.literatureConfig.query, 'Revised scientific query');
  assert.equal(refreshedDraft.subject.getSaved()[mod.id].literatureReviewAppliedRevision, undefined, 'A restored draft still needs explicit application before a new run');
  h.subject.swapLiteratureRevision(mod, false); assert.equal(h.current.literatureJob, null); assert.equal(h.current.literatureConfig.query, 'Revised scientific query');
  assert.equal(h.subject.getSaved()[mod.id].literatureRuleReviewId, REVIEW); assert.doesNotThrow(() => JSON.stringify(h.subject.getSaved()));
  for (const failure of ['api', 'snapshot', 'quota']) {
    const rejected = harness(), raw = rejected.storage.get(KEY);
    if (failure === 'api') rejected.setApiFailure(new Error('No usable confirmed snapshot'));
    if (failure === 'snapshot') rejected.setStoreFailure(true);
    if (failure === 'quota') rejected.setStorageFailure(true);
    await rejected.subject.reviseLiteratureConfiguration(mod);
    assert.equal(rejected.current.literatureJob.id, JOB, 'Original job survives ' + failure);
    assert.equal(rejected.subject.getSaved()[mod.id].literatureJobId, JOB); assert.equal(rejected.storage.get(KEY), raw);
    assert.equal(rejected.opens.length, 0); assert.ok(rejected.current.literatureError); assert.equal(rejected.current.literatureBusy, false);
  }
  const retry = harness(); retry.setApiFailure(new Error('Response lost')); await retry.subject.reviseLiteratureConfiguration(mod);
  const firstId = retry.calls[0].body.requestId; retry.setApiFailure(null); await retry.subject.reviseLiteratureConfiguration(mod);
  assert.equal(retry.calls[1].body.requestId, firstId, 'Retry uses the exact same request identity and payload');
  const swapping = harness(); await swapping.subject.reviseLiteratureConfiguration(mod);
  const beforeSwap = JSON.stringify(swapping.subject.getSaved()); swapping.setStorageFailure(true); swapping.subject.swapLiteratureRevision(mod, true);
  assert.equal(swapping.current.literatureJob, null); assert.equal(JSON.stringify(swapping.subject.getSaved()), beforeSwap, 'Failed return preserves the complete revision draft');
  swapping.setStorageFailure(false); swapping.setStoreFailure(true); swapping.subject.swapLiteratureRevision(mod, true);
  assert.equal(swapping.current.literatureJob, null); assert.equal(JSON.stringify(swapping.subject.getSaved()), beforeSwap);
  const running = harness(); running.current.literatureJob.status = 'running'; await running.subject.reviseLiteratureConfiguration(mod); assert.equal(running.calls.length, 0);
  const late = harness(); let finish; late.defer(new Promise(resolve => { finish = resolve; }));
  const pending = late.subject.reviseLiteratureConfiguration(mod); await Promise.resolve();
  const otherTask = { literatureJob: { id: 'other-job' }, literatureBusy: true, busy: true }; late.setCurrent(otherTask); late.setProject('other-project');
  finish(copy(late.review)); await pending;
  assert.equal(late.current, otherTask); assert.equal(otherTask.literatureBusy, true); assert.equal(late.subject.getSaved()[mod.id].literatureJobId, JOB); assert.equal(late.opens.length, 0);
  const changedBasis = harness(); changedBasis.review.ready = false; changedBasis.review.progress.confirmed = 0; changedBasis.review.items.forEach(item => { item.status = 'pending'; });
  await changedBasis.subject.reviseLiteratureConfiguration(mod); assert.equal(changedBasis.current.literatureRuleReview.ready, false, 'Changed-basis confirmations are not forced back to ready');
  const latestDraft = harness(); latestDraft.current.literatureConfig.query = 'Newly prepared query'; latestDraft.current.literatureUntil = 'export';
  await latestDraft.subject.reviseLiteratureConfiguration(mod, { fromHistory: true });
  assert.equal(latestDraft.calls[0].body.fromHistory, true); assert.equal(latestDraft.calls[1].body.action, 'sync');
  assert.equal(latestDraft.calls[1].body.config.query, 'Newly prepared query'); assert.equal(latestDraft.calls[1].body.until, 'export');
  assert.equal(latestDraft.current.literatureConfig.query, 'Newly prepared query'); assert.equal(latestDraft.opens[0].literatureConfig.query, 'Newly prepared query');
  assert.equal(latestDraft.current.literatureRuleReview.ready, false); assert.equal(latestDraft.current.literatureRuleReview.progress.confirmed, 10);
  const guarded = harness(); let finishGuarded; guarded.defer(new Promise(resolve => { finishGuarded = resolve; }));
  const guardedPending = guarded.subject.reviseLiteratureConfiguration(mod); await Promise.resolve();
  guarded.current.literatureConfig.query = 'User updated draft while fork was pending'; finishGuarded(copy(guarded.review)); await guardedPending;
  assert.equal(guarded.current.literatureConfig.query, 'User updated draft while fork was pending'); assert.equal(guarded.current.literatureJob.id, JOB); assert.equal(guarded.opens.length, 0);
  const legacyHistory = harness(); legacyHistory.setApiFailure(Object.assign(new Error('原任务规则快照不属于当前文献会话'), { code: 'REVIEW_SESSION_MISMATCH' }));
  await legacyHistory.subject.reviseLiteratureConfiguration(mod);
  assert.equal(legacyHistory.calls.length, 1); assert.equal(legacyHistory.calls[0].body.fromHistory, undefined, 'Default revision remains strict even for old unmarked workspaces');
  assert.equal(legacyHistory.current.literatureRevisionNeedsHistoryImport, true); assert.equal(legacyHistory.current.literatureJob.id, JOB);
  legacyHistory.setApiFailure(null); await legacyHistory.subject.reviseLiteratureConfiguration(mod, { fromHistory: true });
  assert.equal(legacyHistory.calls[1].body.fromHistory, true, 'Only the next explicit historical import action uses the migration branch');
  console.log('LITERATURE_RULE_REVIEW_REVISION_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
