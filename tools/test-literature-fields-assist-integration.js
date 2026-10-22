#!/usr/bin/env node
'use strict';

// Real route + input service + field-dialog functions, using in-memory DOM,
// storage, Codex and literature snapshots. No socket, browser, AI, user task,
// literature stage or checkpoint is touched by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runFieldsAssist, normalizeFieldsAssistInput, FIELDS_ASSIST_INSTRUCTIONS } = require('./literature-fields-assist');

const root = path.join(__dirname, '..');
const uiSource = fs.readFileSync(path.join(root, 'js/codex.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const STORAGE_KEY = 'research_literature_field_drafts_v1';
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const AI_JOB = '44444444-4444-4444-8444-444444444444';
const plain = value => JSON.parse(JSON.stringify(value));
const field = (changes = {}) => ({ key: 'temperature', label: '处理温度', meaning: '原文报告的处理组环境温度',
  unit: '原文单位', valueType: 'number', required: false, ...changes });
const draftText = fields => JSON.stringify({ fields, unresolved: ['单位换算仍待人工确认'], notes: ['每列对应一个变量'] });
const makeJob = (id = JOB) => ({ id, status: 'cancelled', stage: 'cancelled', resumeStage: 'fulltext', until: 'fulltext',
  config: { topic: '肉鸡热应激', query: 'broiler heat stress', targetFields: ['处理温度'], privateFixtureSecret: 'not scientific settings' },
  counters: { candidates: 10, fulltextFetched: 3, fulltextPdf: 1, fulltextHtml: 2, fulltextPending: 2 }, files: ['candidates.csv'] });

function sourceFunction(source, name, indent = '  ') {
  const prefix = source.includes(indent + 'async function ' + name + '(') ? 'async function ' : 'function ';
  const start = source.indexOf(indent + prefix + name + '(');
  assert.ok(start >= 0, 'Missing production function: ' + name);
  const end = source.indexOf('\n' + indent + '}', start);
  assert.ok(end > start, 'Missing function end: ' + name);
  return source.slice(start, end + indent.length + 2);
}

function backend(job = makeJob()) {
  const calls = [], snapshots = [];
  const live = { ...job };
  let statusAction = null;
  const scholar = new Proxy({
    jobs: new Map([[job.id, live]]),
    snapshot(id) { snapshots.push(id); if (id !== job.id) throw new Error('unknown fixture task'); return plain(job); }
  }, { get(target, property) {
    if (property in target) return target[property];
    throw new Error('Forbidden literature operation: ' + String(property));
  } });
  const codex = {
    session(id) { assert.equal(id, SESSION); calls.push(['session', id]); },
    async status() { calls.push(['status']); if (statusAction) statusAction(); return { loggedIn: true, model: 'fixture-model' }; },
    async run(...args) { calls.push(['run', ...args]); return { id: AI_JOB, sessionId: args[0], status: 'running' }; }
  };
  const context = vm.createContext({ scholar, codex, runFieldsAssist,
    readBody: async req => req.fixtureBody,
    sendJson: (res, status, data) => Object.assign(res, { status, data }) });
  vm.runInContext(sourceFunction(serverSource, 'handleLiterature', '') + '\nglobalThis.handle = handleLiterature;', context);
  return { scholar, codex, calls, snapshots, live, job,
    onStatus(action) { statusAction = action; },
    async route(body) {
      const res = {};
      await context.handle({ method: 'POST', fixtureBody: JSON.stringify(body) }, res, new URL('http://fixture.test/api/literature/fields-assist'));
      return res;
    } };
}

class Element {
  constructor(tag, text = '', className = '') {
    this.tag = tag; this.tagName = tag.toUpperCase(); this.textContent = text || ''; this.className = className;
    this.children = []; this.listeners = {}; this.open = false; this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) { items.forEach(item => { this.children.push(item); if (item && typeof item === 'object') item.parentElement = this; }); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); }
  focus() {}
  querySelectorAll(tag) { return elements(this).slice(1).filter(item => item.tag === tag); }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
}
const elements = element => [element, ...(element.children || []).flatMap(elements)];

const UI_FUNCTIONS = ['literatureConfigKey', 'sameLiteratureConfig', 'literatureConfirmFields', 'ensureLiteratureFieldDrafts', 'saveLiteratureFieldDrafts',
  'addLiteratureField', 'removeLiteratureField', 'validatedLiteratureFields', 'literatureFieldsAssistState',
  'saveLiteratureFieldsAssist', 'literatureFieldsAssistSignature', 'parseLiteratureFieldsPreview',
  'watchLiteratureFieldsAssist', 'requestLiteratureFieldsAssist', 'applyLiteratureFieldsPreview',
  'literatureFieldsAssistForm', 'literatureConfirmForm', 'closeLiteratureFields', 'renderLiteratureFieldsDialog', 'openLiteratureFields', 'confirmLiteratureFields'];

function frontend(storage = new Map(), initialJob = makeJob()) {
  const service = backend(initialJob);
  const calls = [], watches = [], messages = [], body = new Element('body');
  let allowAdvance = false;
  let job = service.job;
  const current = { literatureJob: job, literatureConfig: plain(job.config), literatureUntil: job.until,
    literatureConfirmJob: null, literatureConfirmDrafts: null, busy: false, literatureBusy: false, model: '' };
  const mod = { id: 'fixture-module', messages: [{ role: 'user', text: '仅做肉鸡小样本，暂不提取' }],
    doc: { status: 'approved', content: '保存原始单位，单位换算另行确认' } };
  let response = '建议将处理温度与对照温度分成两个字段；单位规则待确认。';
  let pollError = null;
  let heldPoll = null;
  let pollGate = null;
  const context = vm.createContext({ task: () => current, root: { LiteratureUI: { isBusy: () => false } },
    Store: { getState: () => ({ modules: [mod] }), appendMessage: (...args) => messages.push(args) },
    account: { model: 'fixture-model' }, document: { body, createElement: tag => new Element(tag) },
    node: (tag, text, className) => new Element(tag, text, className),
    session: async () => SESSION, render() {}, persist() {}, saved: {},
    checkLiteratureRuntime: async () => ({ protocolVersion: 1, restartRequired: false }),
    applyLiteratureJob: (_mod, next) => { current.literatureJob = next; },
    watchLiterature: async (moduleId, jobId) => { watches.push({ moduleId, jobId }); },
    request: async (url, options) => {
      const requestBody = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, body: requestBody });
      if (url === '/api/literature/fields-assist') {
        const res = await service.route(requestBody);
        if (res.status !== 202) throw Object.assign(new Error(res.data.error), { status: res.status });
        return res.data;
      }
      if (url.startsWith('/api/codex/job?id=')) {
        if (pollGate) await pollGate;
        if (pollError) throw pollError;
        return { id: AI_JOB, status: 'completed', text: response };
      }
      if (url === '/api/literature/advance' && allowAdvance) {
        return { ...plain(job), status: 'running', stage: 'extract', until: requestBody.until };
      }
      throw new Error('Forbidden execution endpoint: ' + url);
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    TextEncoder, setTimeout: callback => { callback(); return 1; }, clearTimeout() {} });
  const start = uiSource.indexOf('  const literatureFieldDraftKey');
  const end = uiSource.indexOf('  let account', start);
  const stagesStart = uiSource.indexOf('  const LITERATURE_STAGE_ORDER');
  const stagesEnd = uiSource.indexOf('\n', stagesStart);
  const configKeysStart = uiSource.indexOf('  const LITERATURE_CONFIG_KEYS');
  const configKeysEnd = uiSource.indexOf('  function literatureConfigKey', configKeysStart);
  vm.runInContext(uiSource.slice(start, end) + '\n' + uiSource.slice(stagesStart, stagesEnd) + '\n'
    + uiSource.slice(configKeysStart, configKeysEnd) + '\n' + UI_FUNCTIONS.map(name => sourceFunction(uiSource, name)).join('\n')
    + '\nglobalThis.subject = {' + UI_FUNCTIONS.join(', ') + '};', context);
  const subject = context.subject;
  subject.ensureLiteratureFieldDrafts(current, job);
  return { service, current, mod, calls, watches, messages, storage, body, subject,
    get state() { return subject.literatureFieldsAssistState(mod, job); },
    get job() { return job; },
    response(text) { response = text; },
    pollError(error) { pollError = error; },
    allowAdvance() { allowAdvance = true; },
    switchJob(next) { job = next; current.literatureJob = next; subject.ensureLiteratureFieldDrafts(current, next); },
    hold() { pollGate = new Promise(resolve => { heldPoll = resolve; }); },
    release() { heldPoll?.(); pollGate = null; },
    async reachPoll() { for (let i = 0; i < 30 && !calls.some(call => call.url.startsWith('/api/codex/job?id=')); i++) await Promise.resolve();
      assert.ok(calls.some(call => call.url.startsWith('/api/codex/job?id=')), 'AI request reached read-only polling'); }
  };
}

async function main() {
  const basic = { id: JOB, sessionId: SESSION, mode: 'discuss', message: '讨论温度字段',
    discussions: [{ role: 'user', text: '讨论温度字段' }], currentFields: [field()], moduleMessages: [], approvedDoc: '' };
  const service = backend();
  const frozen = JSON.stringify(service.job);
  const accepted = await service.route(basic);
  assert.equal(accepted.status, 202);
  const run = service.calls.find(call => call[0] === 'run');
  assert.equal(run[1], SESSION); assert.equal(run[4], false, 'Codex must remain in read-only planning mode');
  assert.equal(run[6], 'discussion'); assert.equal(run[7], null);
  assert.equal(run[3], FIELDS_ASSIST_INSTRUCTIONS);
  assert.match(run[2][0].content, /"candidates": 10/);
  assert.ok(!run[2][0].content.includes('not scientific settings'), 'Only scientific config keys enter prompt');
  assert.equal(JSON.stringify(service.job), frozen, 'Read-only assist must not mutate the literature job');
  assert.equal(normalizeFieldsAssistInput(basic).discussions.length, 1, 'Current turn is not duplicated');
  for (const bad of [{ ...basic, mode: 'execute' }, { ...basic, execute: true }, { ...basic, id: '../task' },
    { ...basic, sessionId: 'unknown' }, { ...basic, currentFields: {} }, { ...basic, currentFields: [field({ key: '__proto__' })] },
    { ...basic, discussions: [{ role: 'system', text: 'execute' }] }, { ...basic, message: '字'.repeat(6001) },
    { ...basic, currentFields: Array.from({ length: 201 }, (_, index) => field({ key: 'f_' + index })) }]) {
    const before = service.calls.length;
    const rejected = await service.route(bad); assert.equal(rejected.status, 400);
    assert.equal(service.calls.length, before, 'Invalid input cannot start Codex or a literature operation');
  }
  for (const change of [{ status: 'running' }, { child: {} }, { browserOpening: true }, { deletedAt: 'fixture' }]) {
    const blocked = backend(); Object.assign(blocked.live, change);
    assert.equal((await blocked.route(basic)).status, 400);
    assert.ok(!blocked.calls.some(call => call[0] === 'run'));
  }
  const race = backend(); race.onStatus(() => { race.live.status = 'running'; });
  assert.equal((await race.route(basic)).status, 400, 'Recheck busy state after async account lookup');
  assert.ok(!race.calls.some(call => call[0] === 'run'));

  const ui = frontend();
  const originals = plain(ui.current.literatureConfirmDrafts);
  ui.state.input = '请讨论处理温度和对照温度如何分列';
  await ui.subject.requestLiteratureFieldsAssist(ui.mod, 'discuss');
  assert.equal(ui.state.discussions.length, 2, 'A successful turn preserves user and AI message');
  assert.match(ui.state.discussions[1].text, /对照温度/);
  assert.deepEqual(plain(ui.current.literatureConfirmDrafts), originals, 'Discussion cannot edit fields');
  ui.state.input = '先保留原文单位'; await ui.subject.requestLiteratureFieldsAssist(ui.mod, 'discuss');
  assert.equal(ui.state.discussions.length, 4, 'Multiple turns are retained');
  const lastRequest = ui.calls.filter(call => call.url === '/api/literature/fields-assist').at(-1).body;
  assert.equal(lastRequest.id, JOB); assert.equal(lastRequest.currentFields.length, 1);
  assert.equal(lastRequest.discussions.length, 3, 'Next request includes prior complete discussion');
  assert.match(lastRequest.approvedDoc, /原始单位/);
  assert.equal(lastRequest.moduleMessages.length, 1);

  const proposed = [field(), field({ key: 'control_temperature', label: '对照温度', meaning: '原文报告的对照组环境温度' })];
  ui.response(draftText(proposed)); await ui.subject.requestLiteratureFieldsAssist(ui.mod, 'draft');
  assert.deepEqual(plain(ui.current.literatureConfirmDrafts), originals, 'Candidate preview cannot overwrite current fields');
  assert.equal(ui.state.preview.fields.length, 2);
  const form = ui.subject.literatureFieldsAssistForm(ui.mod, ui.current, ui.job);
  assert.ok(elements(form).some(element => /一列只放一个变量/.test(element.textContent)), 'Dialog explains one column per variable');
  const previewRows = elements(form).filter(element => element.tag === 'tr');
  assert.equal(previewRows.length, 3, 'Preview shows each proposed field in a separate table row');
  const requestsBeforeApply = ui.calls.length;
  ui.subject.applyLiteratureFieldsPreview(ui.mod, ui.current, ui.job);
  assert.deepEqual(plain(ui.current.literatureConfirmDrafts), proposed);
  assert.equal(ui.calls.length, requestsBeforeApply, 'Apply is local only, without field confirmation or execution');
  assert.equal(ui.state.discussions.length, 4, 'Saving fields must preserve discussion');
  const saved = JSON.parse(ui.storage.get(STORAGE_KEY))[JOB];
  assert.deepEqual(saved.fields, proposed); assert.equal(saved.assists[ui.mod.id].discussions.length, 4);
  ui.state.input = '后续待讨论'; ui.subject.saveLiteratureFieldsAssist(ui.current);
  assert.deepEqual(JSON.parse(ui.storage.get(STORAGE_KEY))[JOB].fields, proposed, 'Saving discussion must preserve fields');
  const reload = frontend(ui.storage);
  assert.deepEqual(plain(reload.current.literatureConfirmDrafts), proposed);
  assert.equal(reload.state.discussions.length, 4); assert.equal(reload.state.input, '后续待讨论');
  reload.switchJob(makeJob(OTHER_JOB));
  assert.equal(reload.state.discussions.length, 0, 'Field discussion is isolated by original literature task');

  // Exercise the actual visible button -> validated table values -> explicit
  // next-step button. More than 50 independent variables must stay separate.
  const checkpoint = { ...makeJob(), status: 'needs_attention', stage: 'awaiting_confirmation', resumeStage: 'extract', until: 'extract' };
  const direct = frontend(new Map(), checkpoint);
  direct.current.literatureUntil = 'fulltext'; // A stale outer selector cannot block the explicit field gate.
  direct.state.discussions = [{ role: 'user', text: '把讨论过的全部字段分列填入表格，暂不执行提取' },
    { role: 'assistant', text: '每个变量单独一列，保留原文单位，之后由你核对表格。' }];
  const allFields = Array.from({ length: 80 }, (_, index) => field({ key: 'independent_' + index,
    label: '独立字段' + index, meaning: '原文报告的第' + index + '项独立变量', unit: '原文单位' }));
  direct.response(draftText(allFields));
  const directForm = direct.subject.literatureFieldsAssistForm(direct.mod, direct.current, direct.job);
  const fillButton = elements(directForm).find(element => element.tag === 'button' && element.textContent === '按讨论填入表格');
  assert.ok(fillButton && !fillButton.disabled, 'Discussion exposes the direct fill-table action');
  await fillButton.onclick();
  assert.deepEqual(plain(direct.current.literatureConfirmDrafts), allFields, 'Direct action fills all agreed independent variables into editable rows');
  assert.equal(direct.state.preview, null, 'Successful direct fill does not leave a separate unapplied table');
  assert.equal(direct.state.applied.count, 80, 'Visible completion summary identifies how many actual rows were filled');
  assert.deepEqual(plain(direct.state.applied.unresolved), ['单位换算仍待人工确认'], 'Unresolved details remain visible before confirmation');
  assert.ok(!direct.calls.some(call => call.url === '/api/literature/advance'), 'Filling table never implicitly approves or starts extraction');
  const editableTable = direct.subject.literatureConfirmForm(direct.mod, direct.current, direct.job);
  const labels = elements(editableTable).filter(element => element.tag === 'input' && /字段表头名称$/.test(element['aria-label'] || ''));
  const meanings = elements(editableTable).filter(element => element.tag === 'input' && /字段含义$/.test(element['aria-label'] || ''));
  const units = elements(editableTable).filter(element => element.tag === 'input' && /字段单位$/.test(element['aria-label'] || ''));
  assert.deepEqual(labels.map(element => element.value), allFields.map(value => value.label), 'Displayed editable cells contain the generated labels');
  assert.deepEqual(meanings.map(element => element.value), allFields.map(value => value.meaning));
  assert.deepEqual(units.map(element => element.value), allFields.map(value => value.unit));
  const restoredDirect = frontend(direct.storage, checkpoint);
  assert.deepEqual(plain(restoredDirect.current.literatureConfirmDrafts), allFields, 'Actual filled rows persist across a browser refresh');
  assert.equal(JSON.stringify(direct.service.job), JSON.stringify(checkpoint), 'Filling fields cannot alter saved task, candidate or retrieval state');
  const nextButtons = elements(editableTable).filter(element => element.tag === 'button' && element.textContent === '核对表格并开始提取');
  assert.ok(nextButtons.length >= 1 && !nextButtons[0].disabled, 'The real filled table exposes an explicit next-step action');
  direct.allowAdvance();
  await nextButtons[0].onclick();
  const advances = direct.calls.filter(call => call.url === '/api/literature/advance');
  assert.equal(advances.length, 1, 'Only the explicit next click can start a literature stage');
  assert.deepEqual(advances[0].body, { id: JOB, until: 'extract', confirmations: { fields: allFields } },
    'Next stage receives the exact filled schema and original task id, with extraction as the boundary');
  assert.deepEqual(direct.watches, [{ moduleId: direct.mod.id, jobId: JOB }], 'Progress follows the same original literature task');
  assert.ok(direct.calls.every(call => call.url === '/api/literature/fields-assist' || call.url.startsWith('/api/codex/job?id=')
    || call.url === '/api/literature/advance'), 'The flow never launches a fresh search or new task');

  const undoFill = frontend(); undoFill.response(draftText(proposed));
  const undoOriginal = plain(undoFill.current.literatureConfirmDrafts);
  await undoFill.subject.requestLiteratureFieldsAssist(undoFill.mod, 'draft', false, true);
  const undoForm = undoFill.subject.literatureFieldsAssistForm(undoFill.mod, undoFill.current, undoFill.job);
  const undoButton = elements(undoForm).find(element => element.tag === 'button' && /恢复.*草稿|撤销/.test(element.textContent));
  assert.ok(undoButton, 'Direct filling is reversible before field confirmation');
  await undoButton.onclick();
  assert.deepEqual(plain(undoFill.current.literatureConfirmDrafts), undoOriginal);

  const lateFill = frontend(); lateFill.response(draftText(proposed)); lateFill.hold();
  const lateFillRequest = lateFill.subject.requestLiteratureFieldsAssist(lateFill.mod, 'draft', false, true);
  await lateFill.reachPoll(); lateFill.current.literatureConfirmDrafts[0].meaning = '等待期间手动确认的新含义';
  lateFill.release(); await lateFillRequest;
  assert.equal(lateFill.current.literatureConfirmDrafts.length, 1, 'Late direct fill must not overwrite a manually edited table');
  assert.equal(lateFill.current.literatureConfirmDrafts[0].meaning, '等待期间手动确认的新含义');
  assert.ok(lateFill.state.preview, 'Stale generated fields are retained for review rather than applied');
  assert.match(lateFill.state.error, /已有变化/);

  const stale = frontend(); stale.response(draftText(proposed)); stale.hold();
  const pending = stale.subject.requestLiteratureFieldsAssist(stale.mod, 'draft'); await stale.reachPoll();
  stale.current.literatureConfirmDrafts[0].meaning = '用户在等待期间修改的含义';
  stale.release(); await pending;
  const beforeStale = plain(stale.current.literatureConfirmDrafts);
  stale.subject.applyLiteratureFieldsPreview(stale.mod, stale.current, stale.job);
  assert.deepEqual(plain(stale.current.literatureConfirmDrafts), beforeStale, 'Late result cannot overwrite edited fields');
  assert.match(stale.state.error, /已有变化/);
  const changedContext = frontend(); changedContext.response(draftText(proposed));
  await changedContext.subject.requestLiteratureFieldsAssist(changedContext.mod, 'draft');
  changedContext.mod.messages.push({ role: 'user', text: '新增单位约束' });
  changedContext.subject.applyLiteratureFieldsPreview(changedContext.mod, changedContext.current, changedContext.job);
  assert.equal(changedContext.current.literatureConfirmDrafts.length, 1, 'Changed module context invalidates old candidate');
  const switched = frontend(); switched.response(draftText(proposed)); switched.hold();
  const late = switched.subject.requestLiteratureFieldsAssist(switched.mod, 'draft'); await switched.reachPoll();
  switched.switchJob(makeJob(OTHER_JOB)); const otherFields = plain(switched.current.literatureConfirmDrafts);
  switched.release(); await late;
  assert.deepEqual(plain(switched.current.literatureConfirmDrafts), otherFields, 'Late response cannot overwrite a different job');
  assert.equal(switched.state.preview, null, 'Different task cannot inherit the old preview');

  for (const invalid of ['not json', '{}', draftText([field({ meaning: '' })]), draftText([field({ unit: '' })]),
    draftText([field(), field({ key: 'TEMP_erature' })]), draftText([field({ valueType: 'execute' })]),
    draftText(Array.from({ length: 201 }, (_, index) => field({ key: 'f' + index, label: '字段' + index })))]) {
    assert.throws(() => ui.subject.parseLiteratureFieldsPreview(invalid));
  }
  const invalidReply = frontend(); invalidReply.response('{}');
  await invalidReply.subject.requestLiteratureFieldsAssist(invalidReply.mod, 'draft');
  assert.equal(invalidReply.state.preview, null); assert.match(invalidReply.state.error, /fields/);
  assert.equal(invalidReply.current.literatureConfirmDrafts.length, 1, 'Malformed AI result leaves existing fields intact');
  const interrupted = frontend(); interrupted.response(draftText(proposed)); interrupted.pollError(new Error('Failed to fetch'));
  await interrupted.subject.requestLiteratureFieldsAssist(interrupted.mod, 'draft');
  assert.equal(interrupted.state.pending.id, AI_JOB, 'Network failure preserves the accepted AI job for checking');
  assert.match(interrupted.state.error, /Failed to fetch/);
  const posts = interrupted.calls.filter(call => call.url === '/api/literature/fields-assist').length;
  interrupted.pollError(null);
  await interrupted.subject.watchLiteratureFieldsAssist(interrupted.mod, interrupted.job.id);
  assert.equal(interrupted.calls.filter(call => call.url === '/api/literature/fields-assist').length, posts,
    'Checking an accepted job never resends the AI turn');
  assert.equal(interrupted.state.pending, null); assert.equal(interrupted.state.preview.fields.length, 2);
  assert.equal(interrupted.current.literatureConfirmDrafts.length, 1, 'Recovered AI reply remains preview-only');
  const recoveredFill = frontend(); recoveredFill.response(draftText(proposed)); recoveredFill.pollError(new Error('Failed to fetch'));
  await recoveredFill.subject.requestLiteratureFieldsAssist(recoveredFill.mod, 'draft', false, true);
  assert.equal(recoveredFill.state.pending.autoApply, true, 'Accepted direct-fill intent survives a temporary network error');
  recoveredFill.pollError(null); await recoveredFill.subject.watchLiteratureFieldsAssist(recoveredFill.mod, recoveredFill.job.id);
  assert.deepEqual(plain(recoveredFill.current.literatureConfirmDrafts), proposed, 'Checking an accepted reply completes the original fill action');
  assert.equal(recoveredFill.calls.filter(call => call.url === '/api/literature/fields-assist').length, 1, 'Recovery cannot resubmit the accepted AI turn');
  const busy = frontend(); busy.current.literatureJob.status = 'running';
  busy.state.input = '讨论字段'; await busy.subject.requestLiteratureFieldsAssist(busy.mod, 'discuss');
  assert.equal(busy.calls.length, 0, 'Running literature stage blocks sending a planning turn');
  const capacity = frontend();
  capacity.state.discussions = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '完整讨论' + index }));
  capacity.state.input = '还需讨论';
  await capacity.subject.requestLiteratureFieldsAssist(capacity.mod, 'discuss');
  assert.equal(capacity.calls.length, 0, 'Discussion capacity cannot silently drop earlier agreed rules');
  assert.equal(capacity.state.discussions.length, 60); assert.match(capacity.state.error, /完整讨论仍保留/);
  for (const harness of [ui, stale, changedContext, switched, invalidReply, interrupted, capacity, undoFill, lateFill, recoveredFill]) {
    assert.ok(harness.calls.every(call => call.url === '/api/literature/fields-assist' || call.url.startsWith('/api/codex/job?id=')),
      'Assistant can only send planning turns and poll them');
    assert.equal(harness.job.status, 'cancelled', 'Assistant must not resume the literature job');
  }
  console.log('LITERATURE_FIELDS_ASSIST_INTEGRATION_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
