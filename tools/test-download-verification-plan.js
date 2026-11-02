#!/usr/bin/env node
'use strict';

// Real Store and production discussion/editor helpers in an isolated VM.
// No service, model request, download, actual task, or research file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildComposePrompt, workflowPrompt } = require('../server');
const chat = fs.readFileSync(path.join(__dirname, '../js/chat.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const names = ['notifyDiscussionDraftChanged', 'uiOf', 'isBusy', 'downloadProfessionalRuleSection', 'downloadVerificationSection', 'discussDownloadVerification', 'messagesFor', 'buildDocEditor', 'docButton', 'el'];
function fn(name) {
  const start = chat.indexOf('  function ' + name + '('); assert.ok(start >= 0, name);
  return chat.slice(start, chat.indexOf('\n  }', start) + 4);
}
class Element {
  constructor(tag = 'div') { Object.assign(this, { tag, children: [], listeners: {}, value: '', textContent: '', style: {} }); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  dispatch(type) { return this.listeners[type]?.call(this, { type }); }
  focus() { this.focused = true; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
}
const elements = parent => [parent, ...(parent.children || []).flatMap(elements)];
function fixture(content = '# 数据下载方案\n\n来源和范围：FAOSTAT TM，2024年小麦，进口和出口数量，保留原代码和单位。') {
  const storage = new Map(), browser = { localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) } };
  vm.runInNewContext(storeSource, { window: browser });
  const store = browser.Store, mod = store.addModule('下载数据'), other = store.addModule('数据清洗');
  store.saveDoc(mod.id, content); store.approveDoc(mod.id);
  store.markRun(mod.id, { dir: 'old-run', artifacts: [{ name: 'old.csv', size: 42 }] }); store.confirmRun(mod.id);
  store.appendMessage(mod.id, '只讨论核验方法，原范围沿用。', 'user'); store.selectModule(mod.id);
  const preparations = [], requests = [], busyModules = new Set(), composer = new Element('textarea');
  let currentEditor = null, renders = 0, rules = '已确认规则 v3：2024年小麦，保留原值与单位，不做清洗或换算。';
  const forbidden = (...args) => { requests.push(args); throw new Error('No network, model, download, or execution is permitted by this fixture'); };
  const root = { Store: store, TaskManager: { confirmedRules: () => rules },
    CodexUI: { busy: id => busyModules.has(id), prepareRuleDiscussion: id => preparations.push(id) },
    LiteratureUI: { isBusy: () => false, context: () => '' }, ModuleSpace: { sendText: forbidden }, fetch: forbidden };
  const context = vm.createContext({ root, docUi: {}, pendingModules: {}, inputEl: composer, docEditingId: null, docDraftText: '', MAX_DOC_CHARS: 20000,
    getStore: () => store, findModule: (items, id) => items.find(item => item.id === id),
    document: { createElement: tag => new Element(tag), getElementById: () => composer },
    spaceEl: { querySelector: selector => selector === '.doc-card .doc-editor' ? currentEditor : { scrollIntoView() {} } },
    docProfile: () => ({ title: '数据下载方案' }), render: () => { renders++; }, autoGrow() {},
    fetch: forbidden, request: forbidden, postCompose: forbidden, requestReply: forbidden });
  vm.runInContext(names.map(fn).join('\n') + '\nglobalThis.subject={' + names.join(',') + '};', context);
  return { subject: context.subject, context, store, mod, other, composer, storage, requests, preparations, busyModules,
    current: () => store.getState().modules.find(item => item.id === mod.id), get renders() { return renders; },
    setRules: text => { rules = text; },
    editing: () => context.docEditingId, draft: () => context.docDraftText,
    editor() { const body = new Element(); context.subject.buildDocEditor(body, this.current()); currentEditor = elements(body).find(item => item.tag === 'textarea'); return { body, textarea: currentEditor, click: label => elements(body).find(item => item.tag === 'button' && item.textContent === label).dispatch('click') }; } };
}
function snapshot(h) { return { state: plain(h.store.getState()), history: plain(h.store.getDocHistory(h.mod.id)), storage: [...h.storage.entries()] }; }
function checkCandidateSection(section) {
  assert.match(section, /核验与验收（候选，待讨论确认）/);
  for (const question of ['核什么', '怎么核', '谁核', '怎样通过或退回']) assert.ok(section.includes(question), question);
  for (const item of ['与方案一致', '完整且可读', '更新与变化']) assert.ok(section.includes(item), item);
  assert.match(section, /未给定依据.*不自行设定/); assert.match(section, /未接通的能力仅列拟安排/);
  assert.match(section, /审核方案不代表实际数据已通过验收/);
  assert.match(section, /^### 专业核验规则$/m);
  assert.match(section, /\| 编号 \| 检查字段 \| 检查方法 \| 通过条件 \| 适用条件 \| 依据 \|/);
  assert.match(section, /\| P01 \| 待讨论 \| 人工判断 \| 待讨论 \| 全部 \| 待讨论 \|/);
  assert.match(section, /正文中的专业要求也须入表/);
  assert.match(section, /冻结版本读取规则并检查实际文件/);
  assert.match(section, /不用填写技术配置/);
  assert.doesNotMatch(section, /最小=\d|最大=\d/, 'The candidate template must not invent scientific thresholds');
}
function main() {
  const h = fixture(), before = snapshot(h), original = plain(h.current());
  assert.equal(h.subject.discussDownloadVerification(h.mod.id), true);
  assert.deepEqual(snapshot(h), before, 'Opening must not persist, approve, change a prior run, or archive anything');
  assert.equal(h.editing(), h.mod.id); assert.ok(h.draft().startsWith(original.doc.content)); checkCandidateSection(h.draft());
  assert.equal(h.subject.uiOf(h.mod.id).verificationDiscussion, true); assert.match(h.subject.uiOf(h.mod.id).notice, /尚未保存/);
  assert.match(h.composer.value, /先不下载或更新数据/); assert.equal(h.requests.length, 0); assert.deepEqual(h.preparations, [h.mod.id]);
  assert.match(h.composer.value, /一起确定专业规则及依据/); assert.match(h.composer.value, /所有专业要求都要入表/);

  const editor = h.editor(); editor.textarea.value += '\n人工未保存补充：本轮优先核对年份覆盖。'; editor.textarea.dispatch('input');
  const unsaved = h.draft(); h.composer.value = '我已经输入的未发送问题';
  assert.equal(h.subject.discussDownloadVerification(h.mod.id), true);
  assert.equal(h.draft(), unsaved, 'Reopening retains unsaved manual edits'); assert.equal(h.draft().match(/^## 核验与验收/gm).length, 1);
  assert.equal(h.composer.value, '我已经输入的未发送问题', 'Do not overwrite an existing composer draft');
  assert.deepEqual(snapshot(h), before); assert.equal(h.requests.length, 0);

  const messages = plain(h.subject.messagesFor(h.mod.id));
  assert.match(messages[0].text, /研究者确认的执行规则/); assert.match(messages[0].text, /已确认规则 v3/);
  const draftMessages = messages.filter(message => message.text.includes('未保存讨论草稿'));
  assert.ok(draftMessages.length); assert.ok(draftMessages.every(message => /尚未确认，不是执行授权/.test(message.text)));
  assert.ok(draftMessages.map(message => message.text).join('\n').includes('人工未保存补充'));
  assert.ok(messages.some(message => message.text === '只讨论核验方法，原范围沿用。'));
  assert.equal(h.requests.length, 0, 'Constructing discussion context does not send anything');
  editor.click('取消'); assert.equal(h.editing(), null); assert.equal(h.draft(), ''); assert.deepEqual(snapshot(h), before, 'Cancel retains the original approved plan, run, messages, and history');
  assert.equal(h.subject.uiOf(h.mod.id).verificationDiscussion, false);

  // Explicit save uses the existing Store document/history path and clears approval.
  h.subject.discussDownloadVerification(h.mod.id); const savedDraft = h.draft(), saveEditor = h.editor(); saveEditor.click('保存');
  assert.equal(h.current().doc.content, savedDraft); assert.equal(h.current().doc.status, 'draft'); assert.equal(h.current().doc.approvedAt, null);
  assert.deepEqual(plain(h.current().run), original.run, 'Saving the proposal must not replace the previous file run');
  const history = h.store.getDocHistory(h.mod.id); assert.equal(history.length, 1); assert.equal(history[0].content, original.doc.content); assert.equal(history[0].status, 'approved');
  assert.equal(h.editing(), null); assert.equal(h.requests.length, 0);

  for (const heading of ['## 核验与验收', '### 核验与验收（本任务原有内容）', '**核验与验收**：', '## 6. 核验与验收', '6、核验与验收']) {
    const existing = fixture('# 原方案\n\n' + heading + '\n人工已写的核验办法，保留不动。'), bytes = snapshot(existing);
    existing.composer.value = '已有输入，不应被引导覆盖'; existing.subject.discussDownloadVerification(existing.mod.id);
    assert.ok(existing.draft().startsWith(existing.current().doc.content), 'Existing section is preserved when appending the new candidate professional table: ' + heading);
    assert.equal(existing.draft().split(heading).length, 2, 'Do not duplicate the existing verification section');
    assert.match(existing.draft(), /^### 专业核验规则$/m);
    const once = existing.draft(); existing.subject.discussDownloadVerification(existing.mod.id);
    assert.equal(existing.draft(), once, 'Opening again does not duplicate the professional table');
    assert.equal(existing.composer.value, '已有输入，不应被引导覆盖'); assert.deepEqual(snapshot(existing), bytes);
  }
  const complete = fixture('# 原方案\n\n## 核验与验收\n原有检查说明\n\n### 专业核验规则\n\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| UNIT01 | Unit | 允许值 | t | 全部 | 已确认模型输入约定 |');
  const completeBefore = snapshot(complete); complete.subject.discussDownloadVerification(complete.mod.id);
  assert.equal(complete.draft(), complete.current().doc.content, 'An existing professional table retains its confirmed content without a new placeholder');
  assert.deepEqual(snapshot(complete), completeBefore); assert.equal(complete.requests.length, 0);
  for (const kind of ['wrong-module', 'not-active', 'pending-ai', 'file-job']) {
    const locked = fixture(), lockedBefore = snapshot(locked);
    let target = locked.mod.id;
    if (kind === 'wrong-module') { locked.store.selectModule(locked.other.id); target = locked.other.id; }
    if (kind === 'not-active') locked.store.selectModule(locked.other.id);
    const lockedCurrent = snapshot(locked);
    if (kind === 'pending-ai') locked.context.pendingModules[locked.mod.id] = true;
    if (kind === 'file-job') locked.busyModules.add(locked.mod.id);
    assert.equal(locked.subject.discussDownloadVerification(target), false, kind); assert.equal(locked.editing(), null);
    assert.equal(locked.draft(), ''); assert.equal(locked.composer.value, ''); assert.equal(locked.preparations.length, 0); assert.equal(locked.requests.length, 0);
    assert.deepEqual(snapshot(locked), lockedCurrent); assert.deepEqual(plain(locked.current().doc), lockedBefore.state.modules.find(mod => mod.id === locked.mod.id).doc);
  }
  const overflow = fixture('原'.repeat(19900)), overflowBefore = snapshot(overflow);
  assert.throws(() => overflow.subject.discussDownloadVerification(overflow.mod.id), /字数上限/);
  assert.deepEqual(snapshot(overflow), overflowBefore); assert.equal(overflow.editing(), null); assert.equal(overflow.preparations.length, 0);
  const otherDraft = fixture(), otherDraftBefore = snapshot(otherDraft);
  otherDraft.context.docEditingId = otherDraft.other.id; otherDraft.context.docDraftText = '其他环节尚未保存的内容';
  assert.throws(() => otherDraft.subject.discussDownloadVerification(otherDraft.mod.id), /另一个环节仍有未保存/);
  assert.equal(otherDraft.draft(), '其他环节尚未保存的内容'); assert.equal(otherDraft.editing(), otherDraft.other.id);
  assert.deepEqual(snapshot(otherDraft), otherDraftBefore); assert.equal(otherDraft.preparations.length, 0);

  const prompt = buildComposePrompt({ mode: 'doc', template: 'standard', module: { type: 'download-data', name: '下载数据' },
    messages, revision: { baseDoc: original.doc } });
  assert.ok(prompt.includes(original.doc.content));
  for (const phrase of ['同一份方案内保留“核验与验收”', '不另建第二份规则', '核什么、怎么核、谁核、怎样通过或退回', '方案一致、完整且可读、更新与变化']) assert.ok(prompt.includes(phrase), phrase);
  assert.match(prompt, /不重复索要官方代码、链接/); assert.match(prompt, /候选或待确认/);
  assert.match(prompt, /未实现的核验能力不得写成已运行/); assert.match(prompt, /不执行任务/);
  assert.match(prompt, /不能声称已实际下载/); assert.match(prompt, /未保存讨论草稿/);
  for (const phrase of ['### 专业核验规则', '编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据',
    '必需字段、非空、允许值、数值范围、唯一键、记录数、人工判断', '不要求研究者填写JSON',
    '冻结版本确定性读取', '正文专业要求也须归入表', '待决定而非忽略或宣称已执行',
    '没有专业表的旧方案会如实显示待确认', '下载环节只检查，不修改、删除、插补或换算原值']) assert.ok(prompt.includes(phrase), phrase);
  const ordinary = workflowPrompt({ type: 'download-data', name: '下载数据' });
  for (const phrase of ['### 专业核验规则', '正文专业要求也须归入表', '人工判断', '审核方案不代表已检查文件或启动下载']) assert.ok(ordinary.includes(phrase), 'Module dialogue: ' + phrase);
  assert.ok(!buildComposePrompt({ mode: 'doc', module: { type: 'clean-data' } }).includes('【专业核验规则与实际执行】'), 'The professional download compiler guidance stays in its own module');

  // Reserve the actual server's 30-message window for complete confirmed
  // rules and unsaved proposal text, even after a lengthy discussion.
  const long = fixture('当前方案开头\n' + '案'.repeat(17500) + '\n当前方案结尾');
  const longRules = '已确认规则起点\n' + '规'.repeat(11940) + '\n已确认规则终点'; long.setRules(longRules);
  for (let i = 1; i <= 35; i++) long.store.appendMessage(long.mod.id, '讨论记录第' + i + '条', i % 2 ? 'user' : 'assistant');
  const longBefore = snapshot(long); assert.equal(long.subject.discussDownloadVerification(long.mod.id), true);
  const longMessages = plain(long.subject.messagesFor(long.mod.id)); assert.equal(longMessages.length, 30);
  const ruleChunks = longMessages.filter(message => message.text.startsWith('以下是研究者确认的执行规则'));
  const draftChunks = longMessages.filter(message => message.text.startsWith('以下是同一份下载方案的未保存讨论草稿'));
  const joinChunks = chunks => chunks.map(message => message.text.slice(message.text.indexOf('\n') + 1)).join('');
  assert.equal(joinChunks(ruleChunks), longRules, 'Keep every character of the complete confirmed rules');
  assert.equal(joinChunks(draftChunks), long.draft(), 'Keep every character of the unsaved discussion plan');
  assert.ok(longMessages.every(message => message.text.length < 4000), 'Chunk wrappers must fit the server per-message limit');
  assert.ok(longMessages.some(message => message.text === '讨论记录第35条')); assert.ok(!longMessages.some(message => message.text === '讨论记录第1条'));
  const longPrompt = buildComposePrompt({ mode: 'doc', module: { type: 'download-data' }, messages: longMessages });
  for (const marker of ['已确认规则起点', '已确认规则终点', '当前方案开头', '当前方案结尾', '核验与验收（候选，待讨论确认）', '讨论记录第35条']) assert.ok(longPrompt.includes(marker), 'The actual compose normalizer retains ' + marker);
  assert.deepEqual(snapshot(long), longBefore); assert.equal(long.requests.length, 0);
  console.log('DOWNLOAD_VERIFICATION_PLAN_TESTS_PASS');
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
