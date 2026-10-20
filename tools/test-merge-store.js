#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const data = new Map();
const browser = {
  console,
  localStorage: {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, String(value))
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), { window: browser });
const store = browser.Store;

const download = store.addModule('下载数据');
assert.equal(download.type, 'download-data');
assert.equal(store.saveDoc(download.id, '来源与验收规则').status, 'draft');
assert.equal(store.approveDoc(download.id), true);
assert.equal(store.submitModule(download.id), false);
assert.equal(store.approveModule(download.id).ok, false);
store.markRun(download.id, { artifacts: [{ name: 'original.csv', size: 120 }] });
assert.equal(store.submitModule(download.id), false);
assert.equal(store.confirmRun(download.id), true);
store.submitModule(download.id);
const approved = store.approveModule(download.id);
assert.equal(approved.ok, true);
assert.equal(approved.created.type, 'calculation');
assert.equal(store.getState().activeModuleId, approved.created.id);

const snapshot = JSON.parse(JSON.stringify(store.getState()));
assert.equal(store.restoreState(snapshot), true);
const restored = store.getState();
assert.equal(restored.modules[0].type, 'download-data');
assert.equal(restored.modules[0].doc.status, 'approved');
assert.equal(restored.modules[0].status, 'approved');
assert.equal(restored.modules[1].type, 'calculation');

const legacy = JSON.parse(JSON.stringify(snapshot));
legacy.modules = [{
  id: 'legacy-step', name: '① 文献调研', step: 'literature',
  spec: { goal: '调研', todo: [], output: '报告', acceptance: '完成' },
  dependsOn: null, createdAt: new Date().toISOString(), messages: []
}];
legacy.activeModuleId = 'legacy-step';
assert.equal(store.restoreState(legacy), true);
assert.equal(store.getState().modules[0].type, 'legacy-writing');

console.log('MERGE_STORE_TESTS_PASS');
