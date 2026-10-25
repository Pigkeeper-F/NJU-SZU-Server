#!/usr/bin/env node
'use strict';

// Real Store + real workspace manager; no service, browser, network, or real data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readSource = file => fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const KEY = 'research_literature_workspaces_v1';
const storage = new Map();
let denied = null, processing = false, project = 'project-a', sequence = 0, rejectCommit = false;
const browser = {
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => {
      if (key === denied) throw new Error('fixture quota');
      if (rejectCommit && key === KEY && !Object.values(JSON.parse(value).projects).some(bucket => bucket.pendingSwitch)) {
        rejectCommit = false; throw new Error('fixture final commit failed');
      }
      storage.set(key, String(value));
    },
    removeItem: key => { if (key === denied) throw new Error('fixture quota'); storage.delete(key); }
  },
  crypto: { randomUUID: () => 'context-' + ++sequence }
};
vm.runInNewContext(readSource('store.js'), { window: browser });
const store = browser.Store;
const mod = store.addModule('文献挖掘');
const sibling = store.addModule('模型调整与计算');
store.selectModule(mod.id);
store.appendMessage(mod.id, '肉鸡小样的讨论', 'user');
store.saveDoc(mod.id, '原审核规则'); store.approveDoc(mod.id);
store.saveDoc(mod.id, '肉鸡现行规则'); store.approveDoc(mod.id);
store.markRun(mod.id, { artifacts: [{ name: 'candidates.csv', size: 30 }] });
store.setModuleStatus(mod.id, 'doing');
// Match the normalized shape used after an ordinary page reload.
store.restoreState(store.getState());
let client = { literatureJobId: 'sample-a', sessionId: 'session-a',
  literatureMaterialsParentId: 'sample-a', literatureMaterialsChildId: 'materials-child',
  literatureMaterialsParentDraft: { id: 'sample-a', config: { query: 'unconfirmed parent draft' }, until: 'export' },
  literatureConfig: { topic: '肉鸡小样', query: 'broiler', searchMode: 'test', fieldDefinitions: [{ key: 'temperature', unit: '°C' }] },
  literatureUntil: 'fulltext', literatureDelivered: 'old-stamp' };
let rules = { draft: '小样规则', confirmed: '小样规则', versions: [{ text: '小样规则' }] };
let legacy = { binding: { id: 'legacy-a', sessionId: 'session-a' }, state: { run: { id: 'legacy-a', status: 'waiting' } } };
let chat = { editing: true, draftText: '还没保存的规则', composer: '还没发的讨论', files: [{ name: 'a.csv', content: 'old input' }] };
let applyDenied = false, requests = 0;
browser.fetch = () => { requests++; throw new Error('Must never request'); };
browser.TaskManager = {
  currentTaskId: () => project,
  snapshotModuleRules: () => clone(rules),
  restoreModuleRules: (id, next) => { rules = clone(next); return true; }
};
browser.ModuleSpace = {
  isBusy: () => processing,
  snapshotContext: () => clone(chat),
  resetContext: (id, next) => { if (processing) return false; chat = clone(next); return true; }
};
browser.LiteratureUI = {
  isBusy: () => processing,
  snapshotContext: () => clone(legacy),
  restoreContext: (id, next) => { if (processing) return false; legacy = clone(next); return true; }
};
function boot() {
  vm.runInNewContext(readSource('literature-task-workspaces.js'), { window: browser });
  return browser.LiteratureTaskWorkspaces.createManager({ moduleId: mod.id, adapter: {
    snapshotClient: () => clone(client),
    applyClient: next => { if (applyDenied) { applyDenied = false; return false; } client = clone(next); return true; },
    isBusy: () => processing
  } });
}
let manager = boot();
assert.equal(manager.ensure().ok, true);
const a = manager.active();
assert.match(a.name, /肉鸡小样/);
const aModule = JSON.stringify(store.getState().modules.find(item => item.id === mod.id));
const aClient = JSON.stringify(client), aLegacy = JSON.stringify(legacy), aChat = JSON.stringify(chat), aRules = JSON.stringify(rules);
const aHistory = JSON.stringify(store.getDocHistory(mod.id));
const siblingBytes = JSON.stringify(store.getState().modules.find(item => item.id === sibling.id));

const b = manager.create({ name: '肉鸡正式检索', mode: 'formal', seedDoc: '正式规则待核对', seedClient: {
  ...clone(client), literatureConfig: { ...clone(client.literatureConfig), searchMode: 'formal' },
  confirmations: { fields: true }, materials: ['must not copy'], extraction: { confirmed: true }
} });
assert.equal(b.ok, true);
assert.equal(b.context.mode, 'formal');
assert.equal(client.sessionId, undefined); assert.equal(client.literatureJobId, undefined);
assert.equal(client.confirmations, undefined); assert.equal(client.materials, undefined);
assert.equal(client.literatureMaterialsParentDraft, undefined, 'Reused new-task seeds must not inherit material task links or parent drafts');
assert.equal(client.literatureMaterialsChildId, undefined);
assert.equal(client.literatureConfig.fieldDefinitions[0].unit, '°C');
let currentModule = store.getState().modules.find(item => item.id === mod.id);
assert.equal(currentModule.messages.length, 0); assert.equal(currentModule.run, null);
assert.equal(currentModule.doc.status, 'draft'); assert.equal(currentModule.doc.approvedAt, null);
assert.equal(currentModule.status, 'todo'); assert.equal(store.getDocHistory(mod.id).length, 0);
assert.equal(legacy, null); assert.equal(chat, null); assert.equal(rules.confirmed, '');
store.appendMessage(mod.id, '正式任务讨论', 'user');
client.literatureConfig.query = 'formal query';
client.literatureJobId = 'formal-b'; client.sessionId = 'session-b';
const bClient = JSON.stringify(client);
chat = { composer: '正式任务未发消息' }; legacy = { binding: { id: 'legacy-b' } };

const c = manager.create({ name: '水产新主题' });
assert.equal(c.ok, true); assert.equal(c.context.mode, 'test');
assert.deepEqual(client, {});
assert.equal(store.getState().modules.find(item => item.id === mod.id).doc, null);
store.appendMessage(mod.id, '水产讨论', 'user');
assert.equal(manager.saveActive().ok, true);
manager = boot();
assert.equal(manager.active().id, c.context.id, 'Reload retains selected subtask');
assert.equal(manager.switch(a.id).ok, true);
assert.equal(JSON.stringify(store.getState().modules.find(item => item.id === mod.id)), aModule);
assert.equal(JSON.stringify(client), aClient); assert.equal(JSON.stringify(legacy), aLegacy);
assert.equal(client.literatureMaterialsParentDraft.config.query, 'unconfirmed parent draft', 'Switching and reloading retain the original parent configuration draft');
assert.equal(JSON.stringify(chat), aChat); assert.equal(JSON.stringify(rules), aRules);
assert.equal(JSON.stringify(store.getDocHistory(mod.id)), aHistory);
assert.equal(manager.switch(b.context.id).ok, true);
assert.equal(JSON.stringify(client), bClient);
assert.equal(store.getState().modules.find(item => item.id === mod.id).messages[0].text, '正式任务讨论');
assert.equal(chat.composer, '正式任务未发消息');
assert.equal(JSON.stringify(store.getState().modules.find(item => item.id === sibling.id)), siblingBytes, 'Other workflow modules stay intact');

processing = true;
const beforeBusy = JSON.stringify([...storage]);
assert.equal(manager.create({ name: '不得创建' }).ok, false);
assert.equal(manager.switch(a.id).ok, false);
assert.equal(JSON.stringify([...storage]), beforeBusy);
processing = false;
for (const key of [KEY, 'fa_doc_history_v1', 'fa_state_v1', 'research_task_state_project-a']) {
  const before = JSON.stringify([...storage]), active = manager.active().id, moduleBytes = JSON.stringify(store.getState());
  denied = key;
  assert.equal(manager.switch(a.id).ok, false, 'Storage failure must abort ' + key);
  denied = null;
  assert.equal(manager.active().id, active); assert.equal(JSON.stringify(store.getState()), moduleBytes);
  assert.equal(JSON.stringify([...storage]), before);
}
const beforeApply = JSON.stringify([...storage]);
const clientBeforeApply = JSON.stringify(client), stateBeforeApply = JSON.stringify(store.getState());
applyDenied = true;
assert.equal(manager.switch(a.id).ok, false);
assert.equal(JSON.stringify(client), clientBeforeApply);
assert.equal(JSON.stringify(store.getState()), stateBeforeApply);
assert.equal(JSON.stringify([...storage]), beforeApply);
rejectCommit = true;
assert.equal(manager.switch(a.id).ok, false, 'A rejected final commit rolls live state back too');
assert.equal(JSON.stringify(client), clientBeforeApply);
assert.equal(JSON.stringify(store.getState()), stateBeforeApply);
assert.equal(JSON.stringify([...storage]), beforeApply);

project = 'project-b';
assert.equal(manager.ensure().ok, true);
assert.equal(manager.list().length, 1, 'Project task lists are isolated even if a module id is reused');
project = 'project-a'; assert.equal(manager.list().length, 3);
assert.equal(manager.switch('unknown-context').ok, false);
// Simulate a tab closing after some cross-key writes but before final commit.
assert.equal(manager.saveActive().ok, true);
const directory = JSON.parse(storage.get(KEY)), bucket = directory.projects['project-a:' + mod.id];
const beforeCrashId = bucket.activeId;
const sourceSnapshot = clone(bucket.contexts.find(item => item.id === beforeCrashId).snapshot);
const interruptedTarget = bucket.contexts.find(item => item.id === a.id);
bucket.pendingSwitch = { fromId: beforeCrashId, toId: a.id, at: 'fixture interrupted transition' };
storage.set(KEY, JSON.stringify(directory));
client = clone(interruptedTarget.snapshot.client);
const partialState = store.getState();
partialState.modules = partialState.modules.map(item => item.id === mod.id ? clone(interruptedTarget.snapshot.module) : item);
store.restoreState(partialState);
manager = boot(); denied = 'fa_doc_history_v1';
assert.equal(manager.ensure().ok, false, 'Unfinished transaction cannot silently adopt an inconsistent task when storage is denied');
denied = null;
assert.equal(manager.ensure().ok, true, 'Reload recovers the previous durable task');
assert.equal(manager.active().id, beforeCrashId);
assert.deepEqual(client, sourceSnapshot.client);
assert.equal(JSON.parse(storage.get(KEY)).projects['project-a:' + mod.id].pendingSwitch, undefined);
assert.deepEqual(clone(store.getState().modules.find(item => item.id === mod.id)), sourceSnapshot.module);
assert.equal(requests, 0, 'Create/switch/reload never searches, resumes, downloads, or opens a browser');

// Exercise the production cache reset helpers with actual function bodies.
function fn(source, name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const chatContext = vm.createContext({
  docUi: { a: { notice: 'old' } }, docTemplate: { a: 'mining' }, docFiles: { a: [{ name: 'old' }] }, urlList: { a: ['old'] }, previewOpen: { a: { old: true } },
  docEditingId: 'a', docDraftText: 'unsaved edit', inputEl: { value: 'unsent text' }, msgListState: { moduleId: 'a' },
  activeModuleId: () => 'a', autoGrow() {}, spaceEl: null, isBusy: () => processing
});
vm.runInContext(fn(readSource('chat.js'), 'snapshotContext') + '\n' + fn(readSource('chat.js'), 'resetContext'), chatContext);
const cache = clone(chatContext.snapshotContext('a'));
processing = true; assert.equal(chatContext.resetContext('a'), false); assert.equal(chatContext.inputEl.value, 'unsent text');
processing = false; assert.equal(chatContext.resetContext('a'), true); assert.equal(chatContext.inputEl.value, '');
assert.equal(chatContext.docUi.a, undefined); assert.equal(chatContext.docFiles.a, undefined);
assert.equal(chatContext.resetContext('a', cache), true); assert.equal(chatContext.inputEl.value, 'unsent text');
assert.equal(chatContext.docDraftText, 'unsaved edit');

const legacyStorage = new Map();
const legacyContext = vm.createContext({
  saved: { a: { id: 'old-run' }, other: { id: 'keep' } }, states: { a: { run: { status: 'waiting' }, watching: false } },
  key: 'research_literature_runs_v1', localStorage: { setItem: (key, value) => legacyStorage.set(key, value) }
});
vm.runInContext(fn(readSource('literature.js'), 'snapshotContext') + '\n' + fn(readSource('literature.js'), 'restoreContext'), legacyContext);
const oldLegacy = clone(legacyContext.snapshotContext('a'));
assert.equal(legacyContext.restoreContext('a', null), true); assert.equal(legacyContext.saved.a, undefined);
assert.equal(legacyContext.saved.other.id, 'keep');
assert.equal(legacyContext.restoreContext('a', oldLegacy), true); assert.equal(legacyContext.saved.a.id, 'old-run');
assert.equal(legacyContext.states.a.initialized, true, 'Restoration cannot auto-start legacy polling');
legacyContext.states.a.watching = true; assert.equal(legacyContext.restoreContext('a', null), false);

console.log('LITERATURE_TASK_WORKSPACES_TESTS_PASS');
