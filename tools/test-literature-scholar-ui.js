'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { normalizeConfig } = require('./literature-config');
const { LiteratureRuleReviewStore, GROUPS } = require('./literature-rule-review');
const plan = () => ({ version: 1, topics: [{ id: 'broiler-heat', label: '肉鸡热应激', query: 'broiler "heat stress"' }], yearSpan: 5, sort: 'relevance', trialMaxPages: 2 });
const config = extra => ({ topic: '原研究范围', query: 'broiler "heat stress"', sources: ['google-scholar'],
  publicationYearFrom: 2020, publicationYearTo: 2024, searchMode: 'formal', stopMode: 'end', ...extra });

test('optional Scholar plan survives normalization; absent legacy plan remains absent', () => {
  const legacy = normalizeConfig(config());
  assert.equal(Object.hasOwn(legacy, 'scholarPlan'), false);
  assert.deepEqual(normalizeConfig(config({ scholarPlan: plan() })).scholarPlan, plan());
  assert.equal(Object.hasOwn(normalizeConfig(config({ scholarPlan: null })), 'scholarPlan'), false);
  const noTrial = plan(); delete noTrial.trialMaxPages;
  assert.equal(Object.hasOwn(normalizeConfig(config({ scholarPlan: noTrial })).scholarPlan, 'trialMaxPages'), false);
});

test('version 2 explicitly retains whole-period plans and independent supplements', () => {
  for (const [primaryCount, supplementCount] of [[66, 70], [54, 115]]) {
    const topics = ['primary', 'supplement'].flatMap((phase, index) =>
      Array.from({ length: index === 0 ? primaryCount : supplementCount }, (_, i) => ({
        id: `${phase}-${i}`, label: `${phase} ${i}`, query: `${phase} query ${i}`,
        refinementQueries: [`${phase} child a ${i}`, `${phase} child b ${i}`]
      })));
    const whole = { version: 2, yearSpan: 0, sort: 'relevance', topics };
    const input = config({ publicationYearFrom: 2000, publicationYearTo: 2026, scholarPlan: whole });
    const normalized = normalizeConfig(input);
    assert.deepEqual(normalized.scholarPlan, whole);
    assert.equal(normalized.scholarPlan.topics.length, primaryCount + supplementCount);
    assert.equal(normalized.scholarPlan.topics[primaryCount].id, 'supplement-0');
    assert.equal(Object.hasOwn(normalized.scholarPlan, 'trialMaxPages'), false);
    assert.equal(normalized.perSourceLimit, null);
  }
});

test('version and year strategy cannot be silently coerced across frozen contracts', () => {
  for (const [version, yearSpan] of [[1, 0], [2, 5], [2, false], [2, '0'], [3, 0]]) {
    assert.throws(() => normalizeConfig(config({ scholarPlan: { ...plan(), version, yearSpan } })), /谷歌学术|Scholar/);
  }
  const wholeTrial = { ...plan(), version: 2, yearSpan: 0 };
  assert.deepEqual(normalizeConfig(config({ scholarPlan: wholeTrial })).scholarPlan, wholeTrial);
  assert.throws(() => normalizeConfig(config({ scholarPlan: wholeTrial, stopMode: 'count' })), /formal\/end/);
});

test('malformed plans fail rather than being silently dropped or weakening the trial boundary', () => {
  for (const mutate of [p => { p.version = 2; }, p => { p.yearSpan = 10; }, p => { p.sort = 'date'; },
    p => { p.topics = []; }, p => { p.topics.push({ ...p.topics[0] }); }, p => { p.topics[0].query = ' '; },
    p => { p.trialMaxPages = 0; }, p => { p.trialMaxPages = 101; }, p => { p.topics[0].refinementQueries = ['']; },
    p => { p.topics[0].id = '不合法的编号'; }, p => { p.topics[0].refinementQueries = ['same', 'same']; },
    p => { p.topics[0].refinementQueries = [p.topics[0].query]; }]) {
    const invalid = plan(); mutate(invalid);
    assert.throws(() => normalizeConfig(config({ scholarPlan: invalid })), /谷歌学术|Scholar/);
  }
  assert.throws(() => normalizeConfig(config({ sources: ['pubmed'], scholarPlan: plan() })), /谷歌学术|Scholar/);
  assert.throws(() => normalizeConfig(config({ searchMode: 'test', stopMode: 'count', scholarPlan: plan() })), /谷歌学术|Scholar/);
  assert.throws(() => normalizeConfig(config({ searchMode: 'formal', stopMode: 'count', scholarPlan: plan() })), /谷歌学术|Scholar/);
});

test('plan is human reviewed and edits invalidate query and execution confirmations', async t => {
  const root = await fs.mkdtemp(path.join(path.resolve(__dirname, '..'), '.test-scholar-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LiteratureRuleReviewStore(root), sessionId = '11111111-1111-4111-8111-111111111111';
  let review = await store.create({ sessionId, workspaceId: 'independent-trial', config: config({ scholarPlan: plan() }), until: 'discover' });
  assert.deepEqual(review.items.find(x => x.id === 'source-queries').value.scholarPlan, plan());
  for (const group of GROUPS) review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'group-confirm', groupId: group.id });
  const changed = plan(); changed.topics[0].query = 'broiler temperature';
  review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'sync', config: config({ scholarPlan: changed }), until: 'discover' });
  assert.equal(review.items.find(x => x.id === 'source-queries').status, 'pending');
  assert.equal(review.items.find(x => x.id === 'search-mode').status, 'pending');
  await assert.rejects(store.create({ sessionId, workspaceId: 'unsafe-trial', config: config({ scholarPlan: plan() }), until: 'fulltext' }), /预试|候选|discover/);
});

test('legacy persisted review keeps original keys, config fingerprint and bytes on reload', async t => {
  const root = await fs.mkdtemp(path.join(path.resolve(__dirname, '..'), '.test-scholar-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LiteratureRuleReviewStore(root), sessionId = '33333333-3333-4333-8333-333333333333';
  let review = await store.create({ sessionId, workspaceId: 'old-formal-workspace', config: config(), until: 'discover' });
  for (const group of GROUPS) review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'group-confirm', groupId: group.id });
  const file = path.join(root, '.workbench', 'literature-rule-reviews', review.id, 'review.json');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  persisted.items.find(item => item.id === 'source-queries').keys = ['sourceQueries'];
  const bytes = JSON.stringify(persisted, null, 2) + '\n'; await fs.writeFile(file, bytes);
  const restored = await new LiteratureRuleReviewStore(root).get(review.id, sessionId);
  assert.deepEqual(restored.items.find(item => item.id === 'source-queries').keys, ['sourceQueries']);
  const execution = await store.execution({ id: review.id, sessionId, workspaceId: review.workspaceId, revision: review.revision, config: review.config, until: 'discover' });
  assert.equal(Object.hasOwn(execution.config, 'scholarPlan'), false);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  const changed = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'sync', config: config({ scholarPlan: plan() }), until: 'discover' });
  assert.deepEqual(changed.items.find(item => item.id === 'source-queries').keys, ['sourceQueries', 'scholarPlan']);
  assert.deepEqual((await store.get(review.id, sessionId)).config.scholarPlan, plan());
});

async function uiFunctions() {
  const code = await fs.readFile(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
  const start = code.indexOf('  function scholarTrialSeed('), end = code.indexOf('\n  async function hydrateLiteratureWorkspace(', start);
  assert.ok(start > 0 && end > start, 'independent trial seed must be an actual UI function');
  const context = vm.createContext({}); vm.runInContext(code.slice(start, end) + '\nthis.seed = scholarTrialSeed;', context);
  return context.seed;
}

class Element {
  constructor(tag) { Object.assign(this, { tag, children: [], textContent: '', value: '', listeners: {} }); }
  append(...items) { items.forEach(item => { item.parent = this; this.children.push(item); }); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  querySelectorAll(selector) { return all(this).filter(item => selector.split(/,\s*/).includes(item.tag)); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, value) { this.listeners[key] = value; }
  showModal() { this.open = true; }
  focus() {}
  close() { this.open = false; this.listeners.close?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
}
const all = element => [element, ...element.children.flatMap(all)];
const rendered = element => all(element).map(entry => entry.textContent).filter(Boolean).join('\n');
async function functionSource(name) {
  const code = await fs.readFile(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
  const prefix = code.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = code.indexOf(prefix + name + '('); assert.ok(start >= 0, name + ' production function exists');
  return code.slice(start, code.indexOf('\n  }', start) + 4);
}

test('production trial button creates only a separate editable draft without starting or confirming', async () => {
  const current = { literatureConfig: config({ inclusion: ['原研究范围'] }) }, original = JSON.stringify(current);
  const body = new Element('body'), calls = [], mod = { id: 'mod-1' };
  const context = vm.createContext({ document: { body }, literatureNewTaskDialog: null,
    node: (tag, text = '') => Object.assign(new Element(tag), { textContent: text }),
    literatureWorkspaceManager: () => ({ ensure: () => ({ ok: true }), create: args => { calls.push(args); return { ok: true }; } }),
    literatureWorkspaceBusy: () => false, task: () => current, saved: {},
    Store: { getState: () => ({ modules: [mod] }) }, literatureSource: () => 'new-source', persist() {}, render() {}, ModuleSpace: { render() {} },
    request() { throw new Error('draft must not execute network requests'); } });
  vm.runInContext(await functionSource('scholarTrialSeed') + '\n' + await functionSource('openScholarTrial') + '\nthis.openTrial = openScholarTrial;', context);
  context.openTrial(mod);
  assert.ok(rendered(body).includes('最多2页，仅候选'));
  all(body).find(entry => entry['aria-label'] === '短查询（可以修改，不改变原研究范围）').value = 'duck temperature';
  all(body).find(entry => entry['aria-label'] === '起始年份（可以修改）').value = '2015';
  all(body).find(entry => entry['aria-label'] === '截止年份（可以修改）').value = '2019';
  all(body).find(entry => entry.tag === 'form').onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0].seedDoc, null);
  assert.equal(calls[0].seedClient.literatureConfig.scholarPlan.topics[0].query, 'duck temperature');
  assert.equal(calls[0].seedClient.literatureUntil, 'discover'); assert.equal(JSON.stringify(current), original);
});

test('source progress presents saved pages, human next page and coverage gaps without inventing unknown zeroes', async () => {
  const context = vm.createContext({ node: (tag, text = '') => Object.assign(new Element(tag), { textContent: text }) });
  vm.runInContext(await functionSource('literatureDiscoveryProgress') + '\nthis.progress = literatureDiscoveryProgress;', context);
  assert.equal(context.progress({}), null);
  const result = context.progress({ discoveryProgress: { source: 'google-scholar', batchLabel: '肉鸡热应激', yearFrom: 2020, yearTo: 2024,
    pagesSaved: 12, nextPage: 13, processedBatches: 0, pendingBatches: 2, coverageGaps: 1, status: 'coverage_limited', recoveryMessage: '恢复到第13页，已有记录保留' } });
  const text = rendered(result);
  for (const value of ['肉鸡热应激', '2020', '2024', '12', '13', '覆盖缺口', '恢复到第13页']) assert.ok(text.includes(value), value);
  const unknown = rendered(context.progress({ discoveryProgress: { source: 'google-scholar', pagesSaved: null, nextPage: null, coverageGaps: null, status: 'pending' } }));
  assert.ok(!unknown.includes('0页')); assert.ok(!unknown.includes('第0页')); assert.ok(!unknown.includes('缺口0'));
});

test('workspace reload reads job once without starting, restarting or confirming', async () => {
  const current = {}, requests = [], mod = { id: 'trial-mod' };
  const job = { id: 'saved-trial', discoveryProgress: { source: 'google-scholar', nextPage: 2, pagesSaved: 1 } };
  const context = vm.createContext({ task: () => current, saved: { [mod.id]: { literatureJobId: job.id } }, render() {},
    request: async (url, options) => { requests.push({ url, options }); return job; } });
  vm.runInContext(await functionSource('hydrateLiteratureWorkspace') + '\nthis.reload = hydrateLiteratureWorkspace;', context);
  await context.reload(mod);
  assert.equal(requests.length, 1); assert.equal(requests[0].options, undefined);
  assert.equal(requests[0].url, '/api/literature/job?id=saved-trial'); assert.equal(current.literatureJob.discoveryProgress.nextPage, 2);
});

test('actual review explains the same Scholar plan in query and execution groups in plain language', async t => {
  const root = await fs.mkdtemp(path.join(path.resolve(__dirname, '..'), '.test-scholar-review-ui-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LiteratureRuleReviewStore(root), sessionId = '22222222-2222-4222-8222-222222222222';
  let review = await store.create({ sessionId, workspaceId: 'separate-trial', config: config({ scholarPlan: plan() }), until: 'discover' });
  review = await store.act({ id: review.id, sessionId, revision: review.revision, action: 'set-group', groupId: 'search' });
  review.items.forEach(item => { item.annotation = { explanation: 'Offline fixture explanation' }; });
  const body = new Element('body'), context = vm.createContext({ window: {}, document: { body, createElement: tag => new Element(tag) }, setTimeout, Promise });
  vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'js', 'literature-rule-review.js'), 'utf8'), context);
  const calls = [];
  await context.window.LiteratureRuleReview.open({ sessionId, workspaceId: review.workspaceId, config: review.config, until: 'discover', isCurrent: () => true,
    onSave() {}, request: async (url, options) => { calls.push(url); if (url.endsWith('/action')) review.currentGroupId = JSON.parse(options.body).groupId; return JSON.parse(JSON.stringify(review)); } });
  assert.ok(rendered(body).includes('谷歌学术分批计划')); assert.ok(rendered(body).includes('每5年'));
  await all(body).find(entry => entry.tag === 'button' && entry.textContent.startsWith('4. ')).onclick();
  assert.ok(rendered(body).includes('最多2页')); assert.ok(rendered(body).includes('仅候选'));
  assert.ok(calls.every(url => !/\/search|\/advance|\/assist/.test(url)));
});

test('trial draft clones rules without old jobs, confirmation or execution and keeps editable query/year', async () => {
  const seed = await uiFunctions(), original = config({ topic: '全部动物生产与排放', inclusion: ['保持原研究范围'], scholarPlan: null });
  const current = { backend: 'local', model: 'test', literatureConfig: original, literatureJob: { id: 'old-formal-job' }, literatureRuleReview: { ready: true } };
  const result = seed(current, { query: 'duck "heat stress"', yearFrom: 2015, yearTo: 2019 });
  assert.equal(result.literatureUntil, 'discover');
  assert.equal(result.literatureConfig.scholarPlan.trialMaxPages, 2);
  assert.equal(result.literatureConfig.scholarPlan.topics[0].query, 'duck "heat stress"');
  assert.equal(result.literatureConfig.publicationYearFrom, 2015);
  assert.equal(result.literatureConfig.publicationYearTo, 2019);
  assert.equal(result.literatureConfig.topic, original.topic);
  assert.deepEqual(Array.from(result.literatureConfig.sources), ['google-scholar']);
  assert.equal(result.literatureJob, undefined); assert.equal(result.literatureRuleReview, undefined);
  assert.equal(original.scholarPlan, null); assert.equal(original.publicationYearFrom, 2020);
});
