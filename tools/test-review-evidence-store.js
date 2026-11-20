'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const storage = new Map();
let quotaFull = false;
let activeTask = 'task-one';
function boot(data = storage) {
  const localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      if (quotaFull) throw new Error('QuotaExceededError');
      data.set(key, value);
    }
  };
  const window = { localStorage, TaskManager: { currentTaskId: () => activeTask } };
  vm.runInNewContext(source, { window, URL });
  return window.Store;
}
const store = boot();
const literature = store.startFlow().id;
const sample = { claim: ' 研究结论 ', source: '论文题名或 DOI', locator: '第 5 页，表 2', excerpt: '原文摘录', url: 'https://example.org/paper' };
const first = store.saveReviewEvidence(literature, { ...sample, verifiedAt: new Date().toISOString() });
assert.ok(first.ok);
const get = (s = store, id = literature) => plain(s.getReviewEvidence(id));
assert.equal(get()[0].verifiedAt, null);
assert.equal(get()[0].claim, '研究结论');
assert.ok(store.initFlowModules().created > 0);
const modules = store.getState().modules;
const writing = modules.find(m => m.step === 'writing').id;
assert.equal(store.getReviewEvidenceOwnerId(literature), literature);
assert.equal(store.getReviewEvidenceOwnerId(writing), literature);
assert.deepEqual(get(store, writing), get());
assert.equal(modules.find(m => m.id === writing).reviewEvidence, undefined);
const options = { original: get()[0], taskId: activeTask };
assert.ok(store.saveReviewEvidence(writing, { ...sample, id: first.id, verified: true }, options).ok);
const verified = get()[0];
assert.ok(Date.parse(verified.verifiedAt));
assert.ok(!store.saveReviewEvidence(literature, { ...sample, id: first.id, verified: true }, options).ok);
assert.ok(!store.removeReviewEvidence(writing, first.id, options).ok);
assert.ok(store.saveReviewEvidence(writing, { ...verified, locator: '图 3', verified: true }, { original: verified }).ok);
assert.equal(get()[0].verifiedAt, null);
assert.equal(get()[0].locator, '图 3');
assert.ok(store.saveReviewEvidence(literature, { ...get()[0], verified: true }).ok);
const snapshot = plain(store.getState());
assert.ok(store.restoreState(snapshot));
assert.deepEqual(get(boot()), get());
assert.deepEqual(get(boot(new Map([['fa_state_v1', JSON.stringify(snapshot)]]))), get());
const recovered = boot(new Map());
const dirtySnapshot = plain(snapshot);
const dirtyOwner = dirtySnapshot.modules.find(m => m.step === 'literature');
const saved = dirtyOwner.reviewEvidence[0];
dirtyOwner.reviewEvidence.push(
  { ...saved },
  { ...saved, id: 'unsafe-url', url: 'javascript:alert(1)' },
  { ...saved, id: 'incomplete', locator: '' },
  { ...saved, id: 'malformed-stamp', verifiedAt: 'yesterday' }
);
dirtySnapshot.modules.find(m => m.step === 'writing').reviewEvidence = [{ ...saved, id: 'wrong-owner' }];
assert.ok(recovered.restoreState(dirtySnapshot));
assert.deepEqual(get(recovered).map(item => item.id), [first.id, 'malformed-stamp']);
assert.equal(get(recovered)[1].verifiedAt, null);
assert.equal(recovered.getState().modules.find(m => m.step === 'writing').reviewEvidence, undefined);
const mutableCopy = recovered.getReviewEvidence(writing);
mutableCopy[0].claim = '不能修改存储中的结论';
assert.equal(get(recovered)[0].claim, saved.claim);
const staleTab = boot();
assert.ok(store.saveReviewEvidence(literature, { ...sample, claim: '第二条结论' }).ok);
assert.ok(!staleTab.removeReviewEvidence(writing, first.id).ok);
const beforeFailures = get();
const wrong = modules.find(m => m.step === 'question').id;
for (const id of [wrong, 'unknown']) {
  assert.ok(!store.saveReviewEvidence(id, sample).ok);
  assert.ok(!store.removeReviewEvidence(id, first.id).ok);
  assert.deepEqual(get(store, id), []);
}
for (const key of ['claim', 'source', 'locator']) assert.ok(!store.saveReviewEvidence(literature, { ...sample, [key]: '  ' }).ok);
for (const [key, max] of Object.entries(store.LIMITS.REVIEW_EVIDENCE)) {
  const rejected = store.saveReviewEvidence(literature, { ...sample, [key]: '字'.repeat(max + 1) });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes(String(max)));
}
for (const url of ['javascript:alert(1)', 'data:text/plain,hello', '/paper', 'http:paper', 'https://', 'https:///paper']) {
  assert.ok(!store.saveReviewEvidence(literature, { ...sample, url }).ok, url);
}
for (const id of ['wrong-entry', '', null]) assert.ok(!store.saveReviewEvidence(writing, { ...sample, id }).ok);
activeTask = 'task-two';
assert.ok(!store.saveReviewEvidence(literature, sample, { taskId: 'task-one' }).ok);
assert.ok(!store.removeReviewEvidence(literature, first.id, { taskId: 'task-one' }).ok);
activeTask = 'task-one';
quotaFull = true;
assert.ok(!store.saveReviewEvidence(literature, sample).ok);
assert.ok(!store.removeReviewEvidence(literature, first.id).ok);
quotaFull = false;
assert.deepEqual(get(), beforeFailures);
assert.deepEqual(get(boot()), beforeFailures);
const isolated = boot(new Map());
isolated.initDataModelModules();
assert.deepEqual(get(isolated, writing), []);
const daily = isolated.getState().modules.find(m => m.type === 'literature-mining').id;
assert.ok(!isolated.saveReviewEvidence(daily, sample).ok);
const partial = plain(snapshot);
partial.modules = partial.modules.filter(m => m.step !== 'literature');
assert.ok(isolated.restoreState(partial));
assert.equal(isolated.getReviewEvidenceOwnerId(writing), null);
assert.match(isolated.saveReviewEvidence(writing, sample).reason, /文献调研/);
const ambiguous = plain(snapshot);
const owner = ambiguous.modules.find(m => m.step === 'literature');
ambiguous.modules.push({ ...owner, id: 'additional-literature' });
assert.ok(isolated.restoreState(ambiguous));
assert.equal(isolated.getReviewEvidenceOwnerId(writing), null);
assert.equal(isolated.getReviewEvidenceOwnerId('additional-literature'), 'additional-literature');
const old = plain(snapshot);
delete old.modules.find(m => m.step === 'literature').reviewEvidence;
assert.ok(isolated.restoreState(old));
assert.deepEqual(get(isolated), []);
assert.ok(store.removeReviewEvidence(writing, first.id, { original: beforeFailures[0], taskId: activeTask }).ok);
assert.equal(get().length, 1);
console.log('REVIEW_EVIDENCE_STORE_TESTS_PASS');
