#!/usr/bin/env node
'use strict';

// Exercise the real field-editor functions in a DOM/storage harness. No browser,
// server, user task, network request, or repository data is changed by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
const STORAGE_KEY = 'research_literature_field_drafts_v1';
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '(');
  assert.ok(start >= 0, 'Missing production function: ' + name);
  const end = source.indexOf('\n  }', start);
  assert.ok(end >= 0, 'Missing function ending: ' + name);
  return source.slice(start, end + 4);
}

class Element {
  constructor(tag, text, className) {
    this.tag = tag; this.tagName = tag.toUpperCase(); this.textContent = text || '';
    this.className = className || ''; this.children = []; this.listeners = {}; this.open = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) { for (const item of items) { this.children.push(item); if (item && typeof item === 'object') item.parentElement = this; } }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children.length = 0; this.append(...items); }
  setAttribute(key, value) { this[key] = value; }
  getAttribute(key) { return this[key] ?? null; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; if (this.onclose) this.onclose(); if (this.listeners.close) this.listeners.close(); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  focus() {}
  querySelectorAll(selector) { return elements(this).slice(1).filter(item => item.tag === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function elements(parent) {
  if (!parent || typeof parent !== 'object') return [];
  return [parent, ...(parent.children || []).flatMap(elements)];
}

const PRODUCTION_FUNCTIONS = ['literatureConfigKey', 'sameLiteratureConfig', 'literatureConfirmFields', 'ensureLiteratureFieldDrafts', 'saveLiteratureFieldDrafts',
  'addLiteratureField', 'removeLiteratureField', 'validatedLiteratureFields', 'literatureConfirmForm',
  'closeLiteratureFields', 'renderLiteratureFieldsDialog', 'openLiteratureFields', 'confirmLiteratureFields'];

function createHarness(storage = new Map()) {
  let current = null;
  let failRequest = null;
  let failStorage = false;
  const calls = [], watches = [], applied = [], messages = [];
  const body = new Element('body');
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => { if (failStorage) throw new Error('fixture storage full'); storage.set(key, String(value)); },
    removeItem: key => storage.delete(key)
  };
  const context = vm.createContext({
    root: { LiteratureUI: { isBusy: () => false } }, task: () => current, localStorage,
    document: { body, createElement: tag => new Element(tag), getElementById: () => null, dispatchEvent() {} },
    node: (tag, text, className) => new Element(tag, text, className),
    render() {}, persist() {}, saved: {},
    request: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (failRequest) throw failRequest;
      return { ...current.literatureJob, status: 'running' };
    },
    applyLiteratureJob: (mod, job) => { applied.push({ mod, job }); current.literatureJob = job; },
    watchLiterature: async (moduleId, jobId) => watches.push({ moduleId, jobId }),
    Store: { appendMessage: (...args) => messages.push(args) },
    CustomEvent: class {}, TextEncoder, setTimeout: callback => { callback(); return 1; }, clearTimeout() {}
  });
  const functions = PRODUCTION_FUNCTIONS.map(functionSource).join('\n');
  const stagesStart = source.indexOf('  const LITERATURE_STAGE_ORDER');
  const stagesEnd = source.indexOf('\n', stagesStart);
  assert.ok(stagesStart >= 0);
  const initialStart = source.indexOf('  const literatureFieldDraftKey');
  const initialEnd = source.indexOf('  let account', initialStart);
  assert.ok(initialStart >= 0 && initialEnd > initialStart, 'Missing production storage initialization');
  const configKeysStart = source.indexOf('  const LITERATURE_CONFIG_KEYS');
  const configKeysEnd = source.indexOf('  function literatureConfigKey', configKeysStart);
  assert.ok(configKeysStart >= 0 && configKeysEnd > configKeysStart, 'Missing production frozen-config key definitions');
  vm.runInContext(source.slice(initialStart, initialEnd) + '\n'
    + source.slice(stagesStart, stagesEnd) + '\n' + source.slice(configKeysStart, configKeysEnd) + '\n' + functions
    + '\nglobalThis.subject = { ' + PRODUCTION_FUNCTIONS.join(', ') + ' };', context);
  return {
    subject: context.subject, body, calls, watches, applied, messages, storage,
    setCurrent(value) { current = value; }, get current() { return current; },
    setRequestError(error) { failRequest = error; }, setStorageError(value) { failStorage = value; }
  };
}

function makeJob(id, config = {}) {
  return { id, status: 'needs_attention', stage: 'awaiting_confirmation', resumeStage: 'extract', until: 'export',
    config: { topic: 'fixture topic', query: 'fixture query', targetFields: [], fieldDefinitions: [], ...config },
    files: ['candidates.csv'], count: 12 };
}
function makeTask(job) {
  return { literatureJob: job, literatureConfig: plain(job.config), literatureUntil: job.until, literatureBusy: false, busy: false,
    literatureConfirmJob: null, literatureConfirmDrafts: null, literatureError: '' };
}
function field(overrides = {}) {
  return { key: 'temperature', label: '温度', meaning: '处理组报告的环境温度', unit: '°C', valueType: 'number', required: true, ...overrides };
}
function setFields(harness, fields) {
  const t = harness.current;
  t.literatureConfirmJob = t.literatureJob.id;
  t.literatureConfirmDrafts = plain(fields);
}
function button(parent, expression) {
  return elements(parent).find(item => item.tag === 'button' && expression.test(item.textContent));
}

async function main() {
  const harness = createHarness();
  const { subject } = harness;
  const mod = { id: 'module-fixture' };
  const emptyJob = makeJob('empty-job');
  const emptyJobBytes = JSON.stringify(emptyJob);
  harness.setCurrent(makeTask(emptyJob));
  assert.equal(subject.ensureLiteratureFieldDrafts(harness.current, emptyJob).length, 0);
  const emptyForm = subject.literatureConfirmForm(mod, harness.current, emptyJob);
  assert.ok(button(emptyForm, /新增|添加/), 'Empty field gate must offer an add-field button');
  subject.addLiteratureField(mod, harness.current, emptyJob);
  assert.equal(harness.current.literatureConfirmDrafts.length, 1);
  assert.equal(harness.current.literatureConfirmDrafts[0].key, 'field_1');
  subject.addLiteratureField(mod, harness.current, emptyJob);
  const secondKey = harness.current.literatureConfirmDrafts[1].key;
  assert.notEqual(secondKey, 'field_1');
  subject.removeLiteratureField(mod, harness.current, emptyJob, 0);
  assert.equal(harness.current.literatureConfirmDrafts[0].key, secondKey, 'Deleting another row must not rename a surviving key');
  subject.removeLiteratureField(mod, harness.current, emptyJob, 0);
  assert.equal(harness.current.literatureConfirmDrafts.length, 0);
  subject.addLiteratureField(mod, harness.current, emptyJob);
  assert.equal(harness.current.literatureConfirmDrafts.length, 1, 'Can add after deleting every field');
  assert.equal(JSON.stringify(emptyJob), emptyJobBytes, 'Draft edits must not mutate frozen config or candidate metadata');
  assert.equal(harness.calls.length, 0, 'Adding/removing fields must not execute any task');

  // Saved values survive reconstruction, while another task starts separately.
  setFields(harness, [field({ key: 'field_1', label: '气温', meaning: '实验记录的空气温度' })]);
  assert.equal(subject.saveLiteratureFieldDrafts(harness.current, emptyJob), true);
  const savedFields = JSON.parse(harness.storage.get(STORAGE_KEY))[emptyJob.id].fields;
  assert.equal(savedFields[0].label, '气温');
  const refreshed = createHarness(harness.storage);
  refreshed.setCurrent(makeTask(emptyJob));
  assert.deepEqual(plain(refreshed.subject.ensureLiteratureFieldDrafts(refreshed.current, emptyJob)), savedFields);
  const otherJob = makeJob('other-job');
  refreshed.setCurrent(makeTask(otherJob));
  refreshed.current.literatureConfig.fieldDefinitions = [field({ key: 'foreign-field' })];
  assert.equal(refreshed.subject.ensureLiteratureFieldDrafts(refreshed.current, otherJob).length, 0, 'Drafts cannot leak across job ids');
  refreshed.subject.addLiteratureField(mod, refreshed.current, otherJob);
  refreshed.subject.saveLiteratureFieldDrafts(refreshed.current, otherJob);
  refreshed.setCurrent(makeTask(emptyJob));
  assert.equal(refreshed.subject.ensureLiteratureFieldDrafts(refreshed.current, emptyJob)[0].label, '气温');

  // Base-field edits preserve schema properties supplied by earlier rules.
  const advanced = field({ conditionKeys: ['species', 'country'], allowedRange: { min: -10, max: 60 }, allowedValues: [20, 30] });
  const advancedJob = makeJob('advanced-job', { fieldDefinitions: [advanced] });
  const advancedBytes = JSON.stringify(advancedJob);
  harness.setCurrent(makeTask(advancedJob));
  const advancedDrafts = subject.ensureLiteratureFieldDrafts(harness.current, advancedJob);
  assert.deepEqual(plain(advancedDrafts[0].conditionKeys), advanced.conditionKeys);
  advancedDrafts[0].label = ' 温度表头 '; advancedDrafts[0].meaning = ' 温度含义 '; advancedDrafts[0].unit = ' °C ';
  const validated = subject.validatedLiteratureFields(harness.current);
  assert.equal(validated[0].label, '温度表头'); assert.equal(validated[0].meaning, '温度含义'); assert.equal(validated[0].unit, '°C');
  for (const key of ['conditionKeys', 'allowedRange', 'allowedValues']) assert.deepEqual(plain(validated[0][key]), advanced[key]);
  assert.equal(JSON.stringify(advancedJob), advancedBytes, 'Validation must not edit config or candidate files');
  setFields(harness, [advanced]);
  harness.current.literatureConfig.query = 'changed query';
  const beforeChangedConfig = harness.calls.length;
  await subject.confirmLiteratureFields(mod);
  assert.equal(harness.calls.length, beforeChangedConfig, 'Edited retrieval config cannot confirm fields for a frozen old task');
  assert.match(harness.current.literatureFieldsError, /检索设置已改变/);
  assert.deepEqual(plain(harness.current.literatureConfirmDrafts), [advanced], 'Config mismatch must retain editable field drafts');
  harness.current.literatureConfig = plain(advancedJob.config);
  const deletedJob = makeJob('deleted-default-fields', { fieldDefinitions: [advanced] });
  const deletion = createHarness(); deletion.setCurrent(makeTask(deletedJob));
  deletion.subject.ensureLiteratureFieldDrafts(deletion.current, deletedJob);
  deletion.subject.removeLiteratureField(mod, deletion.current, deletedJob, 0);
  const deletionRefresh = createHarness(deletion.storage); deletionRefresh.setCurrent(makeTask(deletedJob));
  assert.equal(deletionRefresh.subject.ensureLiteratureFieldDrafts(deletionRefresh.current, deletedJob).length, 0,
    'A deliberately emptied saved draft must not restore frozen defaults after refresh');

  // Every invalid schema fails locally before the first request.
  const invalidSchemas = [[], [field({ label: ' ' })], [field({ meaning: '' })], [field({ meaning: '含'.repeat(501) })], [field({ unit: ' ' })], [field({ key: '' })],
    [field(), field({ label: '不同表头' })], [field(), field({ key: 'another' })],
    Array.from({ length: 51 }, (_, index) => field({ key: 'f_' + index, label: '字段' + index }))];
  for (const fields of invalidSchemas) {
    setFields(harness, fields); harness.current.literatureError = ''; harness.current.literatureFieldsError = '';
    assert.throws(() => subject.validatedLiteratureFields(harness.current), 'Invalid field schema must be rejected');
    const before = harness.calls.length;
    await subject.confirmLiteratureFields(mod);
    assert.equal(harness.calls.length, before, 'Invalid fields must make zero HTTP requests');
    assert.ok(harness.current.literatureFieldsError, 'Invalid field gate needs an actionable error');
    assert.deepEqual(plain(harness.current.literatureConfirmDrafts), fields, 'Failed validation must retain editable drafts');
  }
  setFields(harness, [field({ meaning: '含'.repeat(500) })]);
  assert.equal(subject.validatedLiteratureFields(harness.current)[0].meaning.length, 500, 'Meaning allows the backend-compatible 500-character boundary');
  const oversizedFields = Array.from({ length: 50 }, (_, index) => field({ key: 'payload_' + index,
    label: '字段' + index + '名'.repeat(190), meaning: '含'.repeat(500), unit: '无'.repeat(90), valueType: 'text' }));
  const oversizedJSON = JSON.stringify(oversizedFields);
  assert.ok(oversizedJSON.length < 60 * 1024, 'Fixture should fit under the limit in JS characters');
  assert.ok(new TextEncoder().encode(oversizedJSON).byteLength > 60 * 1024, 'Multibyte fixture must exceed the UTF-8 request limit');
  setFields(harness, oversizedFields);
  subject.saveLiteratureFieldDrafts(harness.current, advancedJob);
  assert.throws(() => subject.validatedLiteratureFields(harness.current), /总量超过/);
  const beforeOversized = harness.calls.length;
  await subject.confirmLiteratureFields(mod);
  assert.equal(harness.calls.length, beforeOversized, 'Oversized multibyte schema must be blocked before HTTP');
  assert.match(harness.current.literatureFieldsError, /总量超过/);
  assert.deepEqual(plain(harness.current.literatureConfirmDrafts), oversizedFields, 'Oversized drafts remain editable');
  assert.deepEqual(JSON.parse(harness.storage.get(STORAGE_KEY))[advancedJob.id].fields, oversizedFields, 'Oversized drafts remain saved for editing after refresh');
  setFields(harness, Array.from({ length: 50 }, (_, index) => field({ key: 'field_' + (index + 1), label: '字段' + index })));
  subject.addLiteratureField(mod, harness.current, advancedJob);
  assert.equal(harness.current.literatureConfirmDrafts.length, 50, 'Add action cannot exceed the 50-field limit');

  // Saving a modal before the true gate edits only local drafts, never search.
  const beforeGateJob = { ...makeJob('before-gate'), status: 'completed', stage: 'completed', resumeStage: 'fulltext' };
  harness.setCurrent(makeTask(beforeGateJob));
  setFields(harness, [field()]);
  const beforeModalCalls = harness.calls.length;
  subject.openLiteratureFields(mod);
  const dialog = elements(harness.body).find(item => item.tag === 'dialog');
  assert.ok(dialog && dialog.open, 'Field settings should open a native modal');
  assert.equal(dialog['aria-label'], '提取字段与表头');
  for (const [name, value] of [['表头名称', '编辑后的温度表头'], ['含义', '编辑后的温度含义'], ['单位', '原文单位']]) {
    const input = elements(dialog).find(item => item['aria-label'] === '第1个字段' + name);
    assert.ok(input, 'Editable field control: ' + name); input.value = value; input.oninput();
  }
  const type = elements(dialog).find(item => item['aria-label'] === '第1个字段类型');
  type.value = 'text'; type.onchange();
  const required = elements(dialog).find(item => item['aria-label'] === '第1个字段必填');
  required.checked = false; required.onchange();
  const autoSaved = JSON.parse(harness.storage.get(STORAGE_KEY))[beforeGateJob.id].fields[0];
  assert.equal(autoSaved.label, '编辑后的温度表头'); assert.equal(autoSaved.meaning, '编辑后的温度含义');
  assert.equal(autoSaved.unit, '原文单位'); assert.equal(autoSaved.valueType, 'text'); assert.equal(autoSaved.required, false);
  const save = button(dialog, /保存草稿并关闭/);
  assert.ok(save, 'Modal must offer save-and-close');
  await (save.onclick ? save.onclick() : save.listeners.click());
  assert.equal(harness.calls.length, beforeModalCalls, 'Saving a draft must not invoke search/advance');
  assert.equal(dialog.open, false);
  assert.equal(JSON.parse(harness.storage.get(STORAGE_KEY))[beforeGateJob.id].fields[0].key, 'temperature');

  for (const gate of [beforeGateJob, { ...beforeGateJob, status: 'needs_attention', stage: 'verification' }]) {
    harness.setCurrent(makeTask(gate)); setFields(harness, [field()]);
    const before = harness.calls.length; await subject.confirmLiteratureFields(mod);
    assert.equal(harness.calls.length, before, 'Only the real field-confirmation gate can advance extraction');
  }
  harness.setCurrent(makeTask(advancedJob)); setFields(harness, [advanced]); harness.current.literatureUntil = 'fulltext';
  const beforeEarly = harness.calls.length; await subject.confirmLiteratureFields(mod);
  assert.equal(harness.calls.length, beforeEarly, 'An until boundary before extract cannot confirm fields');

  // HTTP failure retains drafts; success uses exactly the original job/until.
  harness.current.literatureUntil = 'validate';
  harness.setRequestError(new Error('fixture advance rejected'));
  await subject.confirmLiteratureFields(mod);
  assert.match(harness.current.literatureError, /fixture advance rejected/);
  assert.deepEqual(plain(harness.current.literatureConfirmDrafts), [advanced]);
  assert.deepEqual(JSON.parse(harness.storage.get(STORAGE_KEY))[advancedJob.id].fields, [advanced], 'Failed request keeps the draft available after refresh');
  assert.equal(harness.applied.length, 0); assert.equal(harness.watches.length, 0);
  harness.setRequestError(null);
  const beforeSuccess = harness.calls.length;
  await subject.confirmLiteratureFields(mod);
  assert.equal(harness.calls.length, beforeSuccess + 1);
  const last = harness.calls.at(-1);
  assert.equal(last.url, '/api/literature/advance');
  assert.equal(last.body.id, advancedJob.id); assert.equal(last.body.until, 'validate');
  assert.deepEqual(last.body.confirmations.fields, [advanced]);
  assert.ok(!harness.calls.some(call => call.url === '/api/literature/search'), 'Field changes never restart candidate retrieval');
  assert.equal(harness.watches.at(-1).jobId, advancedJob.id);
  assert.equal(JSON.stringify(advancedJob), advancedBytes, 'Confirmation must not mutate the frozen config or earlier candidate metadata');

  const fallback = createHarness(); fallback.setCurrent(makeTask(advancedJob)); setFields(fallback, [advanced]);
  fallback.current.literatureUntil = '';
  await fallback.subject.confirmLiteratureFields(mod);
  assert.equal(fallback.calls[0].body.until, advancedJob.until, 'Missing local boundary must keep the original task until');

  harness.setCurrent(makeTask(makeJob('storage-failure'))); setFields(harness, [field()]); harness.setStorageError(true);
  assert.equal(subject.saveLiteratureFieldDrafts(harness.current, harness.current.literatureJob), false, 'Storage failure must be reported');
  assert.equal(harness.current.literatureConfirmDrafts.length, 1, 'Storage failure must leave editable draft in memory');
  assert.match(harness.current.literatureFieldsError, /保存|存储/);
  subject.openLiteratureFields(mod);
  const failedDialog = elements(harness.body).find(item => item.tag === 'dialog');
  assert.ok(elements(failedDialog).some(item => /无法保存|存储空间/.test(item.textContent)), 'Storage failure is visible in the modal');
  const failedSave = button(failedDialog, /保存草稿并关闭/); await failedSave.onclick();
  assert.equal(failedDialog.open, true, 'Save failure must keep the dialog open');
  const beforeStorageFailure = harness.calls.length; await subject.confirmLiteratureFields(mod);
  assert.equal(harness.calls.length, beforeStorageFailure, 'Failed draft persistence must not submit a confirmation');
  for (const broken of ['{broken', 'null', '[]', '"string"']) {
    const damaged = createHarness(new Map([[STORAGE_KEY, broken]]));
    const freshJob = makeJob('damage-recovery'); damaged.setCurrent(makeTask(freshJob));
    assert.equal(damaged.subject.ensureLiteratureFieldDrafts(damaged.current, freshJob).length, 0, 'Invalid storage must fall back safely');
  }
  console.log('LITERATURE_FIELDS_UI_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
