#!/usr/bin/env node
'use strict';
// Memory-only UI contract: no research tasks, searches, models or files are run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/literature-rule-review.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const all = parent => [parent, ...(parent.children || []).flatMap(all)];
class Element {
  constructor(tag) { Object.assign(this, { tag, tagName: tag.toUpperCase(), textContent: '', className: '', children: [], listeners: {}, value: '' }); }
  append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  querySelectorAll(selector) { return all(this).filter(item => selector.split(/,\s*/).includes(item.tag)); }
}
const specs = [['scope', '范围', [['topic', { topic: 'Original' }], ['years', { publicationYearFrom: 2000, publicationYearTo: 2026 }], ['types', { studyTypes: ['journal'] }]]],
  ['search', '来源', [['sources', { sources: ['pubmed'] }], ['query', { query: 'animals temperature' }], ['source-queries', { sourceQueries: {} }]]]];
function fixture() {
  const items = specs.flatMap(([groupId, , entries]) => entries.map(([id, value]) => ({ id, groupId, title: id, keys: Object.keys(value), value, status: 'pending', history: [], discussion: [], version: 1,
    annotation: { explanation: 'AI fixture explanation', basis: 'Original rules', impact: 'Runtime impact', recommendation: 'Review this value' } })));
  const review = { id: 'review-fixture', sessionId: 'session-fixture', workspaceId: 'workspace-fixture', revision: 1, currentGroupId: 'scope',
    groups: specs.map(([id, title, entries]) => ({ id, title, itemIds: entries.map(([itemId]) => itemId) })), items, until: 'discover', source: 'source-fixture' };
  function refresh() { review.config = Object.assign({}, ...review.items.map(item => item.value)); review.progress = { confirmed: review.items.filter(item => item.status === 'confirmed').length, total: items.length }; review.ready = review.progress.confirmed === items.length; }
  refresh(); return { review, refresh };
}
function harness() {
  const body = new Element('body'), { review, refresh } = fixture(), calls = [], saves = [], applies = [];
  let current = true, deferred = null, assistStart = null, failure = null;
  const adapter = { sessionId: review.sessionId, workspaceId: review.workspaceId, config: copy(review.config), until: review.until, source: review.source,
    sourceLabels: { pubmed: 'PubMed', scopus: 'Scopus' }, context: { messages: [{ role: 'user', text: 'Confirmed rules' }], approvedDoc: '' },
    isCurrent: () => current, onSave: value => saves.push(copy(value)), onApply: value => applies.push(copy(value)),
    request: async (url, options = {}) => {
      const value = options.body ? JSON.parse(options.body) : null; calls.push({ url, value });
      if (failure) throw failure;
      if (deferred) return deferred;
      if (url.endsWith('/create') || url.includes('rule-review?id=')) return copy(review);
      if (url.endsWith('/assist')) return assistStart || { id: 'assistant-fixture', status: 'completed', text: '{}' };
      if (url.startsWith('/api/codex/cancel?id=')) return { id: decodeURIComponent(url.split('=')[1]), status: 'cancelled' };
      if (url.endsWith('/assist-result')) { review.revision += 1; return copy(review); }
      assert.equal(url, '/api/literature/rule-review/action'); assert.equal(value.revision, review.revision);
      const item = review.items.find(entry => entry.id === value.itemId);
      if (value.action === 'confirm') item.status = 'confirmed';
      if (value.action === 'edit') { item.value = copy(value.value); item.status = 'pending'; item.version += 1; item.history.push({ action: 'edit' }); }
      if (value.action === 'set-group') review.currentGroupId = value.groupId;
      if (value.action === 'group-confirm') for (const entry of review.items.filter(entry => entry.groupId === value.groupId)) entry.status = 'confirmed';
      review.revision += 1; refresh(); return copy(review);
    } };
  const context = vm.createContext({ window: {}, document: { body, createElement: tag => new Element(tag) }, setTimeout, Promise });
  vm.runInContext(source, context);
  return { ui: context.window.LiteratureRuleReview, body, adapter, calls, saves, applies, review, setCurrent(value) { current = value; }, defer(value) { deferred = value; }, setAssistStart(value) { assistStart = value; }, fail(value) { failure = value; } };
}
const btn = (h, label) => all(h.body).find(item => item.tag === 'button' && item.textContent === label);
const field = (h, label) => all(h.body).find(item => item['aria-label'] === label);
async function main() {
  const h = harness(); await h.ui.open(h.adapter);
  assert.equal(h.calls[0].url, '/api/literature/rule-review/create');
  assert.deepEqual(h.calls[0].value.context, h.adapter.context, 'Original confirmed text accompanies configuration');
  assert.equal(h.saves.length, 1); assert.equal(btn(h, '使用已确认配置').disabled, true);
  const question = field(h, '关于topic的问题'); question.value = '这个主题怎样执行？'; question.oninput();
  await btn(h, '让 AI 解释').onclick();
  assert.equal(h.calls.find(call => call.url.endsWith('/assist')).value.message, '这个主题怎样执行？');
  assert.ok(h.calls.some(call => call.url.endsWith('/assist-result')), 'Model result is persisted through the dedicated review endpoint');
  assert.equal(h.saves.at(-1).config.topic, 'Original', 'An AI explanation does not change execution settings');
  await btn(h, '确认这一项').onclick(); assert.equal(h.saves.at(-1).items[0].status, 'confirmed');
  btn(h, '修改').onclick(); const input = field(h, '修改研究主题'); input.value = 'Changed topic';
  await all(h.body).find(item => item.tag === 'form').onsubmit({ preventDefault() {} });
  assert.equal(h.saves.at(-1).items[0].status, 'pending'); assert.equal(h.saves.at(-1).config.topic, 'Changed topic');
  assert.equal(h.applies.length, 0, 'Editing or confirmation does not apply or search');
  await btn(h, '确认当前组').onclick();
  await btn(h, '下一组').onclick();
  assert.equal(h.review.currentGroupId, 'search');
  btn(h, '修改').onclick(); field(h, '检索来源 Scopus').checked = true;
  await all(h.body).find(item => item.tag === 'form').onsubmit({ preventDefault() {} });
  assert.deepEqual(h.saves.at(-1).config.sources, ['pubmed', 'scopus']);
  await btn(h, '确认当前组').onclick(); assert.equal(btn(h, '使用已确认配置').disabled, false);
  btn(h, '全部总览').onclick(); assert.ok(all(h.body).some(item => item.textContent === '全部核查项'));
  btn(h, '使用已确认配置').onclick(); assert.equal(h.applies.length, 1); assert.equal(h.body.children.length, 0);
  assert.ok(h.calls.every(call => !call.url.includes('/search')), 'Only the original search entry can start a job');
  const changedOrder = Object.fromEntries(Object.entries(h.review.config).reverse());
  assert.equal(h.ui.matches(h.review, changedOrder, 'discover', 'source-fixture'), true, 'Key ordering does not invalidate unchanged configuration');
  assert.equal(h.ui.matches(h.review, { ...changedOrder, query: 'changed' }, 'discover', 'source-fixture'), false);
  assert.equal(h.ui.matches(h.review, changedOrder, 'fulltext', 'source-fixture'), false);
  assert.equal(h.ui.matches(h.review, changedOrder, 'discover', 'new-source'), false);
  const stale = harness(); let resolve; stale.defer(new Promise(done => { resolve = done; }));
  const opening = stale.ui.open(stale.adapter); stale.setCurrent(false); stale.ui.closeIfContextChanged(); resolve(copy(stale.review)); await opening;
  assert.equal(stale.saves.length, 0, 'A late response cannot mutate another task');
  assert.equal(stale.body.children.length, 0);
  const restored = harness(); restored.adapter.reviewId = restored.review.id; await restored.ui.open(restored.adapter);
  assert.ok(restored.calls[0].url.includes('rule-review?id=')); assert.equal(restored.calls[1].value.action, 'sync');
  restored.ui.close();
  const closing = harness(); await closing.ui.open(closing.adapter);
  let finishStart; closing.setAssistStart(new Promise(resolve => { finishStart = resolve; }));
  const explaining = btn(closing, '让 AI 解释').onclick(); closing.ui.close();
  finishStart({ id: 'only-this-review-turn', status: 'running' }); await explaining; await Promise.resolve(); await Promise.resolve();
  assert.ok(closing.calls.some(call => call.url === '/api/codex/cancel?id=only-this-review-turn'), 'Closing during start interrupts only this dialog\'s late explanatory job');
  assert.equal(closing.calls.filter(call => call.url.endsWith('/assist-result')).length, 0, 'Closed-dialog output is not applied to another task');
  assert.equal(closing.saves.length, 1);
  const failed = harness(); failed.fail(new Error('纳入规则超过数量限制')); await failed.ui.open(failed.adapter);
  assert.ok(all(failed.body).some(item => item.textContent === '未能打开逐项核查'));
  assert.ok(all(failed.body).some(item => item.textContent.includes('原规则和检索设置仍保留')));
  assert.equal(failed.saves.length, 0); assert.ok(btn(failed, '返回检索设置')); assert.ok(btn(failed, '重新尝试'));
  const failedApply = harness(); failedApply.review.ready = true; failedApply.review.progress.confirmed = failedApply.review.items.length;
  failedApply.review.items.forEach(item => { item.status = 'confirmed'; }); failedApply.adapter.onApply = () => { throw new Error('fixture browser quota'); };
  await failedApply.ui.open(failedApply.adapter); btn(failedApply, '使用已确认配置').onclick();
  assert.ok(failedApply.body.children.length); assert.ok(all(failedApply.body).some(item => item.textContent.includes('配置尚未应用') && item.textContent.includes('fixture browser quota')));
  failed.fail(null); await btn(failed, '重新尝试').onclick(); assert.equal(failed.saves.length, 1); failed.ui.close();
  const returning = harness(); let configErrors = 0; returning.adapter.onConfigError = () => { configErrors += 1; };
  returning.fail(new Error('类型不兼容')); await returning.ui.open(returning.adapter); btn(returning, '返回检索设置').onclick();
  assert.equal(configErrors, 1); assert.equal(returning.body.children.length, 0); assert.equal(returning.applies.length, 0);
  const codexSource = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
  const configCode = codexSource.slice(codexSource.indexOf('  const LITERATURE_CONFIG_KEYS'), codexSource.indexOf('  async function prepareLiterature'));
  const effectiveStart = codexSource.indexOf('  function effectiveLiteratureReviewConfig(');
  const effectiveCode = codexSource.slice(effectiveStart, codexSource.indexOf('\n  }', effectiveStart) + 4);
  const draftContext = vm.createContext({ account: { model: 'fixture-model' } });
  vm.runInContext(configCode + '\n' + effectiveCode + '\nglobalThis.helpers={parseLiteratureConfig,literatureDraftRuleList,effectiveLiteratureReviewConfig};', draftContext);
  const helpers = draftContext.helpers, longRules = Array.from({ length: 45 }, (_, index) => '完整规则第' + index + '项');
  const draft = { topic: 'Formal study', query: 'animal thermal environment', sources: ['pubmed'], searchMode: 'formal',
    studyTypes: '期刊论文\n\n硕士和博士论文', inclusion: longRules, exclusion: { conditions: ['不能分离因素', '动物呼吸CO2'], note: '保留全部键值' },
    targetFields: ['体重', { label: '排放', unit: 'g/d', conditions: ['水体', '粪污'] }, 7, null] };
  let notice = ''; const parsed = helpers.parseLiteratureConfig(JSON.stringify(draft), { onFormatNotice: value => { notice = value; } });
  assert.deepEqual(copy(parsed.studyTypes), ['期刊论文', '硕士和博士论文']); assert.deepEqual(copy(parsed.inclusion), longRules);
  assert.deepEqual(JSON.parse(parsed.exclusion[0]), draft.exclusion, 'Object-valued rules retain every key and value');
  assert.deepEqual(JSON.parse(parsed.targetFields[1]), draft.targetFields[1]); assert.equal(parsed.targetFields[2], '7'); assert.equal(parsed.targetFields[3], 'null');
  assert.ok(!JSON.stringify(parsed).includes('[object Object]')); assert.match(notice, /待核查列表/);
  const effective = helpers.effectiveLiteratureReviewConfig({ literatureConfig: draft });
  assert.deepEqual(copy(effective.inclusion), longRules); assert.deepEqual(JSON.parse(effective.exclusion[0]), draft.exclusion);
  assert.throws(() => helpers.parseLiteratureConfig(JSON.stringify({ ...draft, sources: 'pubmed' })), /检索来源/);
  assert.deepEqual(copy(helpers.literatureDraftRuleList(['完整一项\n含原始换行', '二项'])), ['完整一项\n含原始换行', '二项']);
  const baseline = { ...copy(parsed), fieldDefinitions: [{ key: 'fixture_value', label: '原科学变量', meaning: '保持含义', unit: '原单位', valueType: 'number' }],
    templates: { literature: 'fixtures/literature.xlsx', parameters: 'fixtures/parameters.xlsx' }, extraction: { model: 'fixture-model', maxCharsPerPaper: 120000 } };
  let baselineNotice = '';
  const inherited = helpers.parseLiteratureConfig(JSON.stringify(draft), { baseline, onFormatNotice: value => { baselineNotice = value; } });
  assert.deepEqual(copy(inherited.fieldDefinitions), baseline.fieldDefinitions); assert.deepEqual(copy(inherited.templates), baseline.templates);
  assert.match(baselineNotice, /字段定义.*未更新/); assert.match(baselineNotice, /沿用当前草稿/);
  assert.notEqual(inherited.fieldDefinitions, baseline.fieldDefinitions, 'The candidate cannot mutate the previous field schema through shared references');
  const cleared = helpers.parseLiteratureConfig(JSON.stringify({ ...draft, fieldDefinitions: [], templates: null, extraction: null }), { baseline });
  assert.deepEqual(copy(cleared.fieldDefinitions), []); assert.equal(cleared.templates, null); assert.equal(cleared.extraction, null);
  const partialTemplate = helpers.parseLiteratureConfig(JSON.stringify({ ...draft, templates: { literature: null } }), { baseline });
  assert.equal(partialTemplate.templates.literature, null); assert.equal(partialTemplate.templates.parameters, baseline.templates.parameters, 'An omitted template subkey is not an instruction to clear it');
  assert.throws(() => helpers.parseLiteratureConfig(JSON.stringify({ ...draft, fieldDefinitions: 'not a list' }), { baseline }), /字段定义/);
  const prepareStart = codexSource.indexOf('  async function prepareLiterature(');
  const prepareCode = codexSource.slice(prepareStart, codexSource.indexOf('\n  }', prepareStart) + 4);
  const priorReview = { id: 'original-review', revision: 9, ready: true, history: [{ action: 'confirm', note: 'preserve me' }] };
  const prepareTask = { literatureConfig: copy(baseline), literatureUntil: 'discover', literatureRuleReview: copy(priorReview), model: 'fixture-model' };
  const preparedSaves = { fixture: { sessionId: 'session-fixture', literatureRuleReviewId: priorReview.id, literatureRuleReview: copy(priorReview), literatureReviewAppliedRevision: 9 } }, prepareCalls = [];
  const longMessage = '已确定规则'.repeat(1600), approvedDoc = '完整审核文档'.repeat(2500);
  const prepareMod = { id: 'fixture', doc: { status: 'approved', content: approvedDoc }, messages: Array.from({ length: 41 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: index ? 'message-' + index : longMessage })) };
  let snapshots = 0;
  const preparing = vm.createContext({ account: { model: 'fixture-model' }, root: {}, key: 'fixture-key', task: () => prepareTask, saved: preparedSaves,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    literatureWorkspaceManager: () => ({ active: () => ({ id: 'workspace-fixture' }), saveActive: () => { snapshots += 1; } }),
    literatureSource: () => 'new-source', session: async () => 'session-fixture', render() {}, persist() {},
    request: async (url, options) => { prepareCalls.push({ url, body: JSON.parse(options.body) }); return { id: 'prepare-fixture', status: 'completed', text: JSON.stringify(draft) }; } });
  const commitStart = codexSource.indexOf('  function commitLiteratureRevision('), commitCode = codexSource.slice(commitStart, codexSource.indexOf('\n  }', commitStart) + 4);
  vm.runInContext(configCode + '\n' + commitCode + '\n' + prepareCode + '\nglobalThis.prepare=prepareLiterature;globalThis.getSaved=()=>saved;', preparing);
  await preparing.prepare(prepareMod);
  assert.equal(prepareCalls.length, 1); assert.equal(prepareCalls[0].url, '/api/literature/prepare');
  assert.equal(prepareCalls[0].body.messages.length, 41); assert.equal(prepareCalls[0].body.messages[0].text, longMessage, 'Earlier or long confirmed rules must not be silently dropped');
  assert.equal(prepareCalls[0].body.approvedDoc, approvedDoc); assert.deepEqual(prepareCalls[0].body.currentConfig, baseline); assert.equal(prepareCalls[0].body.until, 'discover');
  assert.deepEqual(copy(prepareTask.literatureConfig.fieldDefinitions), baseline.fieldDefinitions); assert.deepEqual(copy(prepareTask.literatureConfig.templates), baseline.templates);
  assert.equal(prepareTask.literatureRuleReview.ready, false); assert.equal(prepareTask.literatureReviewNeedsSync, true);
  assert.equal(preparedSaves.fixture.literatureRuleReviewId, priorReview.id); assert.deepEqual(copy(prepareTask.literatureRuleReview.history), priorReview.history);
  assert.equal(preparing.getSaved().fixture.literatureReviewAppliedRevision, undefined); assert.ok(snapshots >= 3, 'Submission marker, accepted id and completed draft are saved separately');
  assert.ok(!prepareCalls.some(call => call.url.endsWith('/search')), 'Reorganizing rules never confirms or starts the task');
  const { ITEMS } = require('./literature-rule-review');
  const frozenSnapshot = { reviewId: 'frozen-review-fixture', revision: 7, sessionId: 'session-fixture', workspaceId: 'workspace-fixture', confirmedAt: '2026-10-27T10:00:00.000Z',
    config: { topic: 'Frozen original', query: 'frozen query', sources: ['pubmed'] }, until: 'discover', source: 'frozen-source', fingerprint: 'fixture-fingerprint',
    items: ITEMS.map(spec => ({ ...copy(spec), value: spec.id === 'topic' ? { topic: 'Frozen original' } : spec.id === 'stage' ? { version: 2, until: 'discover' } : {}, status: 'confirmed', version: 1,
      annotation: { explanation: '启动时已保存的说明', basis: '原确认依据', impact: '已冻结', recommendation: '原记录' }, history: [{ action: 'confirm', value: { preserved: 'frozen' } }], discussion: [{ question: '原问题', answer: '原答复' }] })) };
  const frozenBytes = JSON.stringify(frozenSnapshot), frozen = harness(); let snapshotReads = 0;
  const frozenAdapter = { ...frozen.adapter, readOnly: true, sourceJobId: 'original-job', sourceJobTitle: '原正式任务',
    loadSnapshot: async () => { snapshotReads += 1; return copy(frozenSnapshot); } };
  await frozen.ui.open(frozenAdapter);
  assert.equal(snapshotReads, 1); assert.equal(frozen.calls.length, 0, 'Frozen viewing never calls review sync/action/assist or execution APIs');
  assert.equal(frozen.saves.length, 0); assert.equal(frozen.applies.length, 0);
  for (const label of ['确认当前组', '确认这一项', '修改', '让 AI 解释', 'AI 说明本组', '使用已确认配置']) assert.equal(btn(frozen, label), undefined, 'Read-only snapshot hides ' + label);
  assert.ok(all(frozen.body).some(item => item.textContent === '已确认 14 / 14'));
  assert.ok(all(frozen.body).some(item => item.textContent.includes('来源任务：原正式任务（original-job）')));
  assert.ok(all(frozen.body).some(item => item.textContent === '启动时已保存的说明'));
  assert.ok(all(frozen.body).some(item => item.textContent.includes('复用当前规则和表头（需重新核对）')));
  await btn(frozen, '下一组').onclick(); assert.equal(frozen.calls.length, 0, 'Group navigation is local and read-only');
  btn(frozen, '全部总览').onclick(); assert.ok(all(frozen.body).some(item => item.textContent === '全部核查项'));
  btn(frozen, '✓ 已确认　研究主题').onclick(); assert.equal(frozen.calls.length, 0);
  assert.equal(JSON.stringify(frozenSnapshot), frozenBytes, 'Rendering and navigation cannot mutate the immutable source snapshot'); frozen.ui.close();
  const contextRevision = harness(); let reviseRequests = 0;
  await contextRevision.ui.open({ ...frozenAdapter, isCurrent: () => true, onRevise: () => { reviseRequests += 1; }, canRevise: true });
  assert.ok(btn(contextRevision, '修改配置并继续')); btn(contextRevision, '修改配置并继续').onclick();
  assert.equal(reviseRequests, 1); assert.equal(contextRevision.body.children.length, 0); assert.equal(contextRevision.calls.length, 0, 'The viewer delegates revision only to its explicit task-context callback');
  await contextRevision.ui.open({ ...frozenAdapter, isCurrent: () => true, onRevise: () => { reviseRequests += 1; }, canRevise: false });
  assert.equal(btn(contextRevision, '修改配置并继续').disabled, true); btn(contextRevision, '修改配置并继续').onclick(); assert.equal(reviseRequests, 1); contextRevision.ui.close();
  const missingSnapshot = harness(); let missingReads = 0;
  const missingAdapter = { ...missingSnapshot.adapter, readOnly: true, sourceJobId: 'legacy-job', loadSnapshot: async () => { missingReads += 1; throw new Error('快照文件不存在'); } };
  await missingSnapshot.ui.open(missingAdapter);
  assert.ok(all(missingSnapshot.body).some(item => item.textContent === '无可用核查快照')); assert.ok(btn(missingSnapshot, '重新尝试'));
  await btn(missingSnapshot, '重新尝试').onclick(); assert.equal(missingReads, 2); assert.equal(missingSnapshot.saves.length, 0); assert.equal(missingSnapshot.calls.length, 0); missingSnapshot.ui.close();
  const incomplete = harness(); await incomplete.ui.open({ ...incomplete.adapter, readOnly: true, sourceJobId: 'broken-job',
    loadSnapshot: async () => ({ ...copy(frozenSnapshot), items: frozenSnapshot.items.slice(1) }) });
  assert.ok(all(incomplete.body).some(item => item.textContent === '无可用核查快照')); assert.ok(!all(incomplete.body).some(item => item.textContent === '已确认 14 / 14')); incomplete.ui.close();
  const staleSnapshot = harness(); let resolveSnapshot;
  const staleOpening = staleSnapshot.ui.open({ ...staleSnapshot.adapter, readOnly: true, sourceJobId: 'old-job', loadSnapshot: () => new Promise(resolve => { resolveSnapshot = resolve; }) });
  staleSnapshot.setCurrent(false); staleSnapshot.ui.closeIfContextChanged(); resolveSnapshot(copy(frozenSnapshot)); await staleOpening;
  assert.equal(staleSnapshot.body.children.length, 0); assert.equal(staleSnapshot.saves.length, 0); assert.equal(staleSnapshot.calls.length, 0);
  const frozenJobId = '12345678-1234-4234-8234-123456789abc', directReads = [], directBody = new Element('body');
  const directWindow = { location: { search: '?literatureReview=' + frozenJobId }, fetch: async (url, options) => {
    directReads.push({ url, options }); return { ok: true, json: async () => copy(frozenSnapshot) };
  } };
  Object.defineProperty(directWindow, 'localStorage', { get() { throw new Error('Read-only URL must not access browser storage'); } });
  const directContext = vm.createContext({ window: directWindow, document: { body: directBody, createElement: tag => new Element(tag) }, URLSearchParams, setTimeout, Promise });
  vm.runInContext(source, directContext); await new Promise(resolve => setImmediate(resolve));
  assert.equal(directReads.length, 1); assert.equal(directReads[0].url, '/api/literature/download?id=' + frozenJobId + '&name=rule-review-confirmed.json');
  assert.ok(!directReads[0].options.method || directReads[0].options.method === 'GET'); assert.ok(all(directBody).some(item => item.textContent === '已确认 14 / 14'));
  assert.ok(all(directBody).some(item => item.textContent === 'Frozen original · 12345678'));
  assert.ok(!all(directBody).some(item => item.textContent === '使用已确认配置')); directWindow.LiteratureRuleReview.close();
  await assert.rejects(() => directWindow.LiteratureRuleReview.openFrozenJob('not-a-task'), /任务标识无效/);
  const invalidWindow = { location: { search: '?literatureReview=invalid%2Fpath' }, fetch: () => { throw new Error('Invalid identifiers must not request a file'); } };
  const invalidBody = new Element('body'); vm.runInContext(source, vm.createContext({ window: invalidWindow, document: { body: invalidBody, createElement: tag => new Element(tag) }, URLSearchParams, setTimeout, Promise }));
  assert.equal(invalidBody.children.length, 0);
  const frozenEntry = harness(), frozenTask = { literatureJob: { id: frozenJobId, status: 'needs_attention', config: { topic: 'Running original' } }, literatureBusy: true, busy: true };
  const frozenTaskBytes = JSON.stringify(frozenTask), frozenSaved = { fixture: { literatureJobId: frozenJobId } }, frozenSavedBytes = JSON.stringify(frozenSaved), entryRequests = [];
  const openReviewStart = codexSource.indexOf('  async function openLiteratureRuleReview(');
  const openReviewCode = codexSource.slice(openReviewStart, codexSource.indexOf('\n  }', openReviewStart) + 4);
  const entryContext = vm.createContext({ root: { LiteratureRuleReview: frozenEntry.ui }, task: () => frozenTask, saved: frozenSaved,
    literatureWorkspaceManager: () => null, Store: { getState: () => ({ activeModuleId: 'fixture' }) }, LITERATURE_SOURCE_LABELS: { pubmed: 'PubMed' },
    request: async url => { entryRequests.push(url); return copy(frozenSnapshot); } });
  vm.runInContext(openReviewCode + '\nglobalThis.openEntry=openLiteratureRuleReview;', entryContext); await entryContext.openEntry({ id: 'fixture' });
  assert.equal(entryRequests.length, 1); assert.ok(entryRequests[0].includes('/api/literature/download?')); assert.equal(JSON.stringify(frozenTask), frozenTaskBytes); assert.equal(JSON.stringify(frozenSaved), frozenSavedBytes);
  assert.equal(frozenEntry.saves.length, 0); assert.equal(frozenEntry.applies.length, 0); frozenEntry.ui.close();
  console.log('LITERATURE_RULE_REVIEW_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
