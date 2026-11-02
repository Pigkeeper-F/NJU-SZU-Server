#!/usr/bin/env node
'use strict';

// Independent, offline integrity checks using the production Store and manager.
// All storage, network and UI adapters are fixtures. No real task is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const read = file => fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
const KEY = 'research_literature_workspaces_v1';

function harness() {
  const storage = new Map();
  let project = 'integrity-project-a', sequence = 0, denied = null;
  let failReset = false, rejectFinalCommit = false, networkCalls = 0, onApplyClient = null;
  let client = { sessionId: 'fixture-session', literatureJobId: 'fixture-job',
    literatureConfig: { topic: 'Original rules', query: 'old query', inclusion: ['confirmed requirement'] },
    literatureUntil: 'discover', literatureRuleReview: { id: 'fixture-review', revision: 3, ready: true },
    literatureRevisionOriginal: { client: { old: true } }, literatureRevisionDraft: { client: { candidate: true } } };
  let rules = { draft: 'Original draft', confirmed: 'Confirmed original', versions: [{ text: 'Confirmed original' }] };
  let legacy = { binding: { id: 'fixture-old-job' }, state: { phase: 'review' } };
  let chat = { editing: true, draftText: 'Original unsaved document', composer: 'Original unsent discussion',
    files: [{ name: 'fixture-original.txt', content: 'original input' }], urls: ['https://example.invalid/original'], previews: { original: true } };
  const browser = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (key === denied) throw new Error('fixture storage denied');
        if (rejectFinalCommit && key === KEY && !Object.values(JSON.parse(value).projects).some(bucket => bucket.pendingSwitch)) {
          rejectFinalCommit = false; throw new Error('fixture final commit rejected');
        }
        storage.set(key, String(value));
      },
      removeItem: key => { if (key === denied) throw new Error('fixture storage denied'); storage.delete(key); }
    },
    crypto: { randomUUID: () => 'integrity-context-' + ++sequence },
    fetch: () => { networkCalls++; throw new Error('No network in integrity test'); },
    TaskManager: { currentTaskId: () => project, snapshotModuleRules: () => clone(rules),
      restoreModuleRules: (id, value) => { rules = clone(value); return true; } },
    ModuleSpace: { isBusy: () => false, snapshotContext: () => clone(chat), render() {},
      resetContext: (id, value) => { if (failReset) { failReset = false; return false; } chat = clone(value); return true; } },
    LiteratureUI: { isBusy: () => false, snapshotContext: () => clone(legacy),
      restoreContext: (id, value) => { legacy = clone(value); return true; } }
  };
  vm.runInNewContext(read('store.js'), { window: browser });
  const store = browser.Store, mod = store.addModule('文献挖掘');
  store.selectModule(mod.id);
  store.appendMessage(mod.id, '原始需求：' + '完整讨论'.repeat(1500) + ' END_OF_FULL_DISCUSSION', 'user');
  store.appendMessage(mod.id, '原始 AI 候选；尚未由研究者确认', 'assistant');
  store.appendMessage(mod.id, '原始运行状态，不能冒充用户决定', 'system');
  store.saveDoc(mod.id, 'Original approved document'); store.approveDoc(mod.id);
  store.restoreState(store.getState());
  function boot() {
    vm.runInNewContext(read('literature-task-workspaces.js'), { window: browser });
    return browser.LiteratureTaskWorkspaces.createManager({ moduleId: mod.id, adapter: {
      snapshotClient: () => clone(client), applyClient: value => { client = clone(value); onApplyClient?.(clone(value)); return true; }, isBusy: () => false
    } });
  }
  const manager = boot(); assert.equal(manager.ensure().ok, true); assert.equal(manager.saveActive().ok, true);
  return { browser, store, mod, storage, manager, boot,
    get client() { return clone(client); }, get rules() { return clone(rules); }, get chat() { return clone(chat); },
    get legacy() { return clone(legacy); }, get project() { return project; }, get networkCalls() { return networkCalls; },
    setProject: value => { project = value; }, deny: key => { denied = key; }, rejectReset: () => { failReset = true; },
    onApplyClient: callback => { onApplyClient = callback; },
    rejectCommit: () => { rejectFinalCommit = true; },
    updateDraft() {
      store.appendMessage(mod.id, 'Only in the modified draft', 'user');
      store.saveDoc(mod.id, 'Unconfirmed modified document');
      client = { sessionId: 'fixture-session', literatureConfig: { topic: 'Modified rules', query: 'NEW CANDIDATE' },
        literatureRuleReview: { id: 'new-fixture-review', revision: 4, ready: false, items: [{ status: 'pending' }] },
        literatureReviewNeedsSync: true, literatureUntil: 'fulltext' };
      rules = { draft: 'Changed but unconfirmed', confirmed: 'Confirmed original', versions: [{ text: 'Confirmed original' }] };
      legacy = { state: { phase: 'candidate' } };
      chat = { editing: true, draftText: 'Modified unsaved document', composer: 'Modified unsent discussion',
        files: [{ name: 'fixture-modified.txt', content: 'draft input' }], urls: [], previews: {} };
    },
    current() { return { state: store.getState(), client: clone(client), rules: clone(rules), chat: clone(chat), legacy: clone(legacy),
      docHistory: clone(store.getDocHistory(mod.id)) }; }
  };
}

function equalSnapshot(h, envelope) {
  const actual = h.current(), expected = envelope.snapshot;
  assert.deepEqual(clone(actual.state.modules.find(item => item.id === h.mod.id)), clone(expected.module));
  for (const key of ['client', 'rules', 'chat', 'legacy', 'docHistory']) assert.deepEqual(actual[key], clone(expected[key]), key);
}

const h = harness();
assert.equal(typeof h.manager.captureCurrent, 'function');
assert.equal(typeof h.manager.restoreCurrent, 'function');
assert.equal(typeof h.manager.snapshot, 'function');
const original = clone(h.manager.captureCurrent());
assert.equal(original.version, 1); assert.equal(original.projectId, h.project); assert.equal(original.moduleId, h.mod.id);
assert.equal(original.workspaceId, h.manager.active().id);
assert.equal(original.snapshot.module.messages.length, 3);
assert.match(original.snapshot.module.messages[0].text, /END_OF_FULL_DISCUSSION$/);
assert.equal(original.snapshot.module.messages[2].role, 'system');
assert.ok(original.snapshot.module.messages.every(message => message.id && message.at));
assert.equal(original.snapshot.client.literatureRevisionOriginal, undefined, 'Branch captures do not recursively nest older branches');
assert.equal(original.snapshot.client.literatureRevisionDraft, undefined);

h.updateDraft();
const draft = clone(h.manager.captureCurrent());
assert.equal(draft.snapshot.module.messages.length, 4); assert.equal(draft.snapshot.module.doc.status, 'draft');
assert.equal(draft.snapshot.client.literatureRuleReview.ready, false);
for (let iteration = 0; iteration < 2; iteration++) {
  assert.equal(h.manager.restoreCurrent(clone(original)).ok, true); equalSnapshot(h, original);
  assert.equal(h.manager.restoreCurrent(clone(draft)).ok, true); equalSnapshot(h, draft);
  assert.equal(h.client.literatureRuleReview.ready, false, 'Restoring a candidate does not confirm it');
  assert.equal(h.client.literatureReviewAppliedRevision, undefined);
}
const persisted = JSON.parse(h.storage.get(KEY));
const bucket = persisted.projects[h.project + ':' + h.mod.id];
assert.equal(bucket.activeId, draft.workspaceId); assert.equal(bucket.pendingSwitch, undefined);
assert.deepEqual(bucket.contexts.find(context => context.id === draft.workspaceId).snapshot.module.messages, draft.snapshot.module.messages);
const reloaded = h.boot(); assert.equal(reloaded.ensure().ok, true);
assert.deepEqual(clone(reloaded.snapshot(draft.workspaceId)), draft, 'Full active snapshot survives manager reload');

for (const [property, value] of [['projectId', 'different-project'], ['moduleId', 'different-module'], ['workspaceId', 'different-workspace']]) {
  const before = JSON.stringify(h.current()), raw = JSON.stringify([...h.storage]);
  assert.equal(reloaded.restoreCurrent({ ...clone(original), [property]: value }).ok, false, 'Wrong ' + property + ' is rejected');
  assert.equal(JSON.stringify(h.current()), before); assert.equal(JSON.stringify([...h.storage]), raw);
}

for (const key of [KEY, 'fa_doc_history_v1', 'fa_state_v1', 'research_task_state_' + h.project]) {
  const before = JSON.stringify(h.current()), raw = JSON.stringify([...h.storage]); h.deny(key);
  assert.equal(reloaded.restoreCurrent(clone(original)).ok, false, 'Rejected storage does not partially restore ' + key); h.deny(null);
  assert.equal(JSON.stringify(h.current()), before); assert.equal(JSON.stringify([...h.storage]), raw);
}
for (const reject of [() => h.rejectReset(), () => h.rejectCommit()]) {
  const before = JSON.stringify(h.current()), raw = JSON.stringify([...h.storage]); reject();
  assert.equal(reloaded.restoreCurrent(clone(original)).ok, false);
  assert.equal(JSON.stringify(h.current()), before, 'A side-effect/final-commit failure restores the whole live context');
  assert.equal(JSON.stringify([...h.storage]), raw, 'A failed transition leaves all saved keys intact');
}

// Same-workspace restore interrupted before final commit must retain an older
// durable snapshot, not overwrite its own recovery source with the new branch.
const registry = JSON.parse(h.storage.get(KEY)), interrupted = registry.projects[h.project + ':' + h.mod.id];
interrupted.pendingSwitch = { fromId: draft.workspaceId, toId: draft.workspaceId, at: 'fixture interrupted same-workspace restore' };
h.storage.set(KEY, JSON.stringify(registry));
const partial = h.store.getState(); partial.modules = partial.modules.map(item => item.id === h.mod.id ? clone(original.snapshot.module) : item);
h.store.restoreState(partial);
const recovered = h.boot(); assert.equal(recovered.ensure().ok, true); equalSnapshot(h, draft);
assert.equal(JSON.parse(h.storage.get(KEY)).projects[h.project + ':' + h.mod.id].pendingSwitch, undefined);

h.setProject('integrity-project-b');
const foreign = h.boot(); assert.equal(foreign.ensure().ok, true);
const untouched = JSON.stringify(h.current()), foreignRaw = JSON.stringify([...h.storage]);
assert.equal(foreign.restoreCurrent(clone(original)).ok, false, 'A reused module ID does not bypass project ownership');
assert.equal(JSON.stringify(h.current()), untouched); assert.equal(JSON.stringify([...h.storage]), foreignRaw);
assert.equal(h.networkCalls, 0, 'Capture/restore/reload never execute, search, resume, call a model, or fetch');

// Exercise the actual revision return buttons' production function on top of
// the real manager. Manager-only tests cannot detect a client-only swap bug.
const revision = harness(), originalBranch = clone(revision.manager.captureCurrent());
revision.updateDraft(); const modifiedBranch = clone(revision.manager.captureCurrent());
const archivedJob = { id: 'fixture-job', status: 'cancelled', config: clone(originalBranch.snapshot.client.literatureConfig) };
let revisionTask = { literatureJob: null, literatureConfig: clone(modifiedBranch.snapshot.client.literatureConfig), busy: false, literatureBusy: false };
const revisionRoot = revision.browser; revisionRoot.LiteratureRuleReview = { close() {} };
const revisionContext = vm.createContext({ root: revisionRoot, Store: revision.store, ModuleSpace: revisionRoot.ModuleSpace,
  saved: { [revision.mod.id]: { ...clone(modifiedBranch.snapshot.client), literatureRevisionOriginal: {
    client: clone(originalBranch.snapshot.client), job: archivedJob, context: originalBranch } } },
  task: () => revisionTask, literatureWorkspaceManager: () => revision.manager,
  hydrateLiteratureWorkspace: async () => {}, render() {}, commitLiteratureRevision() { throw new Error('Full-context return must use the transactional manager'); } });
revision.onApplyClient(client => {
  revisionContext.saved = { [revision.mod.id]: clone(client) };
  revisionTask = { literatureJob: client.literatureJobId ? clone(archivedJob) : null, literatureConfig: clone(client.literatureConfig), busy: false, literatureBusy: false };
});
const codex = read('codex.js'), startSwap = codex.indexOf('  function swapLiteratureRevision(');
assert.ok(startSwap >= 0);
vm.runInContext(codex.slice(startSwap, codex.indexOf('\n  }', startSwap) + 4), revisionContext);
revisionContext.swapLiteratureRevision(clone(revision.mod), true);
assert.deepEqual(clone(revision.store.getState().modules.find(item => item.id === revision.mod.id).messages), originalBranch.snapshot.module.messages);
assert.deepEqual(revision.chat, originalBranch.snapshot.chat);
assert.deepEqual(clone(revision.store.getState().modules.find(item => item.id === revision.mod.id).doc), originalBranch.snapshot.module.doc);
assert.equal(revisionTask.literatureJob.id, archivedJob.id);
assert.ok(revisionContext.saved[revision.mod.id].literatureRevisionDraft.context, 'Returning saves the full modified discussion before restoring the original');
revisionContext.swapLiteratureRevision(clone(revision.mod), false);
assert.deepEqual(clone(revision.store.getState().modules.find(item => item.id === revision.mod.id).messages), modifiedBranch.snapshot.module.messages);
assert.deepEqual(revision.chat, modifiedBranch.snapshot.chat);
assert.deepEqual(clone(revision.store.getState().modules.find(item => item.id === revision.mod.id).doc), modifiedBranch.snapshot.module.doc);
assert.equal(revisionTask.literatureJob, null);
assert.equal(revisionTask.literatureConfig.query, 'NEW CANDIDATE');
assert.equal(revisionContext.saved[revision.mod.id].literatureRuleReview.ready, false, 'The returned discussion remains an unconfirmed candidate');
assert.equal(revision.networkCalls, 0);
console.log('LITERATURE_CONTEXT_INTEGRITY_TESTS_PASS');
