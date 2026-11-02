#!/usr/bin/env node
'use strict';
// Real initialization and Store, memory-only legacy/current storage fixtures.
// No browser, model, search, task execution or actual localStorage is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/tasks.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '..', 'js/store.js'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const BACKUPS = 'research_task_bootstrap_backups_v1', STATE = 'research_task_state_fixture-project';
function fn(name) {
  const start = source.indexOf('  function ' + name + '('); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function fullState() {
  const browser = { localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(storeSource, { window: browser });
  const mod = browser.Store.addModule('文献挖掘'); browser.Store.selectModule(mod.id);
  browser.Store.appendMessage(mod.id, 'Original user requirements', 'user');
  browser.Store.appendMessage(mod.id, 'AI candidate remains a candidate', 'assistant');
  browser.Store.saveDoc(mod.id, 'Confirmed source document'); browser.Store.approveDoc(mod.id);
  browser.Store.restoreState(browser.Store.getState());
  return clone(browser.Store.getState());
}
function harness(mirror, project, options = {}) {
  const storage = new Map(), writes = []; let sequence = 0;
  if (mirror !== null) storage.set('fa_state_v1', typeof mirror === 'string' ? mirror : JSON.stringify(mirror));
  if (project !== null) storage.set(STATE, typeof project === 'string' ? project : JSON.stringify(project));
  storage.set('research_tasks_v1', JSON.stringify({ activeTaskId: 'fixture-project', tasks: [{ id: 'fixture-project', name: 'Existing project', rulesByModule: {} }] }));
  storage.set('research_legacy_projects_imported_v1', '1');
  if (options.backupRaw !== undefined) storage.set(BACKUPS, options.backupRaw);
  const root = { localStorage: { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { if (key === BACKUPS && options.failBackup) throw new Error('fixture quota'); writes.push({ key, value: String(value) }); storage.set(key, String(value)); } } };
  vm.runInNewContext(storeSource, { window: root });
  if (options.failRestore) root.Store.restoreState = () => false;
  const context = vm.createContext({ root, INDEX_KEY: 'research_tasks_v1', STATE_PREFIX: 'research_task_state_',
    BOOTSTRAP_BACKUPS_KEY: BACKUPS, index: null, memory: {}, bootstrapMessage: '', blockedBootstrapProject: null,
    read: key => storage.get(key) ?? null,
    write: (key, value) => { writes.push({ key, value }); storage.set(key, value); return true; },
    id: () => 'fixture-backup-' + ++sequence, saveIndex() { throw new Error('Valid project index must remain valid'); } });
  const functions = ['saveState', 'bootstrapSnapshot', 'bootstrapCanonical', 'bootstrapEqual', 'bootstrapClock',
    'bootstrapProjectMoreComplete', 'preserveBootstrapOriginals', 'recoverBootstrapState', 'initialize'];
  vm.runInContext(functions.map(fn).join('\n'), context);
  context.initialize();
  return { root, storage, writes, context, get state() { return clone(root.Store.getState()); },
    get backups() { return storage.has(BACKUPS) ? JSON.parse(storage.get(BACKUPS)) : null; } };
}
test('a missing current mirror recovers the full saved project before any destructive write', () => {
  const rich = fullState(), h = harness(null, rich);
  assert.deepEqual(h.state, rich); assert.deepEqual(JSON.parse(h.storage.get(STATE)), rich);
  assert.equal(h.backups.entries.length, 1);
  assert.deepEqual(h.backups.entries[0].sources, [{ key: 'fa_state_v1', raw: null }, { key: STATE, raw: JSON.stringify(rich) }]);
  assert.equal(h.writes[0].key, BACKUPS, 'Backup must be the first write');
  assert.match(h.context.bootstrapMessage, /已恢复.*完整讨论/);
});
test('an invalid mirror is preserved byte-for-byte and does not erase a valid project discussion', () => {
  const rich = fullState(), malformed = '{"modules": unfinished';
  const h = harness(malformed, rich);
  assert.deepEqual(h.state, rich); assert.equal(h.backups.entries[0].sources[0].raw, malformed);
});
test('a stale shorter mirror is replaced only by its complete, compatible project lineage', () => {
  const rich = fullState(), mirror = clone(rich); mirror.modules[0].messages = mirror.modules[0].messages.slice(0, 1);
  const h = harness(mirror, rich);
  assert.equal(h.state.modules[0].messages.length, 2);
  assert.equal(h.backups.entries[0].sources[0].raw, JSON.stringify(mirror));
  assert.equal(h.backups.entries[0].sources[1].raw, JSON.stringify(rich));
  assert.equal(h.state.modules[0].doc.status, 'approved', 'Existing source approval is preserved, not invented');
});
test('a newer mirror is preserved whole; old project bytes remain independently recoverable', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].messages.push({ id: 'new-user', role: 'user', text: 'Latest unconfirmed request', at: '2030-01-01T00:00:00Z' });
  mirror.modules[0].doc = { content: 'New candidate document', status: 'draft', updatedAt: '2030-01-01T00:00:00Z', approvedAt: null };
  const h = harness(mirror, old);
  assert.deepEqual(h.state, mirror); assert.equal(h.state.modules[0].doc.status, 'draft');
  assert.equal(h.backups.entries[0].sources[1].raw, JSON.stringify(old));
});
test('divergent message text is never silently merged or substituted', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].messages[0].text = 'Changed current discussion';
  const h = harness(mirror, old);
  assert.deepEqual(h.state, mirror); assert.equal(h.backups.entries[0].sources[1].raw, JSON.stringify(old));
  assert.match(h.context.bootstrapMessage, /当前镜像继续使用/);
});
test('a different current module is retained while the older full discussion is preserved for cross-scope recovery', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].id = 'new-historical-context-module'; mirror.modules[0].messages = []; mirror.activeModuleId = mirror.modules[0].id;
  const h = harness(mirror, old);
  assert.equal(h.state.modules[0].id, mirror.modules[0].id); assert.equal(h.state.modules[0].messages.length, 0);
  assert.equal(JSON.parse(h.backups.entries[0].sources[1].raw).modules[0].messages.length, 2);
});
test('a newer current document or changed settings cannot be discarded for a longer older message list', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].messages = [];
  mirror.modules[0].doc = { content: 'Latest draft', status: 'draft', updatedAt: '2030-01-01T00:00:00Z', approvedAt: null };
  assert.deepEqual(harness(mirror, old).state, mirror);
  const parameters = clone(old); parameters.modules[0].messages = []; parameters.modules[0].params = { changed: 'new setting' };
  assert.deepEqual(harness(parameters, old).state, parameters);
});
test('backup quota failure blocks initialization and subsequent project saves instead of overwriting the only full record', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].messages = [];
  const h = harness(mirror, old, { failBackup: true });
  assert.equal(h.storage.get(STATE), JSON.stringify(old)); assert.equal(h.context.blockedBootstrapProject, 'fixture-project');
  h.root.Store.appendMessage(mirror.modules[0].id, 'New in-memory discussion', 'user');
  assert.equal(h.context.saveState(), false); assert.equal(h.storage.get(STATE), JSON.stringify(old));
  assert.match(h.context.bootstrapMessage, /旧项目记录未覆盖/);
});
test('a corrupt prior backup directory is not overwritten and cannot authorize a destructive save', () => {
  const old = fullState(), mirror = clone(old); mirror.modules[0].messages = [];
  const h = harness(mirror, old, { backupRaw: '{broken backup' });
  assert.equal(h.storage.get(BACKUPS), '{broken backup'); assert.equal(h.storage.get(STATE), JSON.stringify(old));
});
test('restore failure keeps both raw originals and prevents a later autosave overwrite', () => {
  const old = fullState(), h = harness(null, old, { failRestore: true });
  assert.equal(h.storage.get(STATE), JSON.stringify(old)); assert.equal(h.backups.entries[0].sources[1].raw, JSON.stringify(old));
  assert.equal(h.context.saveState(), false);
});
test('equal startup snapshots create no duplicate backup and identical conflicting raw pairs are deduplicated', () => {
  const rich = fullState(), equal = harness(rich, rich); assert.equal(equal.backups, null);
  const mirror = clone(rich); mirror.modules[0].messages = [];
  const first = harness(mirror, rich);
  const repeated = harness(mirror, rich, { backupRaw: JSON.stringify(first.backups) });
  assert.equal(repeated.backups.entries.length, 1);
});
test('an invalid saved project remains byte-for-byte in backup before a valid current mirror replaces it', () => {
  const mirror = fullState(), bad = '{old saved project'; const h = harness(mirror, bad);
  assert.deepEqual(h.state, mirror); assert.equal(h.backups.entries[0].sources[1].raw, bad);
});
