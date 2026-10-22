#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// All file preparation and model calls are stubs. No server or real task is run.
class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.value = ''; this.children = []; this.listeners = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.textContent = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = String(value); }
  get firstElementChild() { return this.children[0]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  dispatchEvent(event) { return this.listeners[event.type]?.call(this, event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  querySelector(selector) {
    if (selector === 'label[for="task-summary-draft"]') return this.label;
    return this.children.find(child => selector.startsWith('.')
      ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector) || null;
  }
}

function fixture() {
  const storage = new Map(), elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('task-summary').append(new Element('span'));
  const dialog = get('rules-dialog');
  dialog.label = new Element('label');
  dialog.append(new Element('h2'), new Element('p'), dialog.label);
  get('conversation-mode').value = 'ai';
  const calls = { sent: [], preparations: 0, cancelled: [], discussions: [] };
  let busy = false, prepare = async () => true;
  const browser = {
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    ModuleSpace: {
      isBusy: () => busy,
      sendText: text => { calls.sent.push(text); return true; }
    },
    CodexUI: {
      useCodex: () => true,
      prepareRuleDiscussion: id => { calls.discussions.push(id); },
      prepareConfirmedExecution: async id => { calls.preparations++; return prepare(id); },
      cancelPreparedExecution: id => calls.cancelled.push(id),
      openDownload: () => { throw new Error('Cleaning must not start a download'); }
    }
  };
  const context = vm.createContext({
    window: browser,
    document: { getElementById: get, createElement: tag => new Element(tag) },
    Event: class { constructor(type) { this.type = type; } }, console
  });
  const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8'), context);
  load('store.js');
  const store = browser.Store;
  const clean = store.addModule('数据清洗');
  load('tasks.js');
  const click = id => get(id).dispatchEvent({ type: 'click' });
  const edit = text => {
    get('task-summary-draft').value = text;
    get('task-summary-draft').dispatchEvent({ type: 'input' });
  };
  const confirm = text => { edit(text); click('task-summary-save'); };
  const refresh = () => {
    assert.equal(typeof browser.TaskManager.refreshControls, 'function', 'Busy-state changes need an explicit, non-destructive refresh');
    browser.TaskManager.refreshControls();
  };
  return {
    browser, store, clean, get, dialog, calls, storage, click, edit, confirm, refresh,
    setBusy: value => { busy = value; },
    setPrepare: value => { prepare = value; },
    status: () => get('task-rules-execution-status').textContent
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  {
    const f = fixture();
    assert.equal(f.get('task-rules-execute').disabled, true);
    assert.match(f.status(), /确认|制定|填写/);
    f.confirm('按同年同商品同单位配对，保留原值，另存核查报告。');
    assert.equal(f.get('task-rules-execute').disabled, false);
    assert.match(f.status(), /执行|就绪|准备/);

    // The final assistant message arrives while the transport is still busy.
    f.setBusy(true);
    f.store.appendMessage(f.clean.id, '已检查字段与输入文件。', 'assistant');
    assert.equal(f.get('task-rules-execute').disabled, true);
    assert.match(f.status(), /正在|等待|处理|任务|稍后/);
    f.setBusy(false);
    f.refresh(); // No subsequent Store event occurs when the transport finishes.
    assert.equal(f.get('task-rules-execute').disabled, false);
    assert.equal(f.get('task-summary-ai').disabled, false);

    // Busy refresh must never replace the editor or lose its in-progress text.
    const editor = f.get('task-summary-draft');
    const draft = '正在手写的草稿，尚未提交。';
    editor.value = draft;
    f.refresh();
    assert.equal(f.get('task-summary-draft'), editor);
    assert.equal(editor.value, draft);
  }

  {
    const f = fixture();
    f.confirm('规则一：只做单位检查。');
    f.edit('规则二：保留原值并另存检查结果。');
    assert.equal(f.get('task-rules-execute').disabled, true, 'Cleaning draft changes require fresh confirmation');
    assert.match(f.status(), /变化|修改|重新确认|重新审核/);
    await f.click('task-rules-execute');
    assert.equal(f.calls.preparations, 0);
    f.click('task-summary-save');
    assert.equal(f.get('task-rules-execute').disabled, false);
    f.get('task-summary-history').value = '0';
    f.get('task-summary-history').dispatchEvent({ type: 'change' });
    assert.equal(f.get('task-summary-draft').value, '规则一：只做单位检查。');
    assert.equal(f.browser.TaskManager.confirmedRules(), '规则二：保留原值并另存检查结果。');
    assert.equal(f.get('task-rules-execute').disabled, true, 'Loading a historical version must not execute the currently confirmed rule');
    await f.click('task-rules-execute');
    assert.equal(f.calls.preparations, 0);
    assert.equal(f.calls.sent.length, 0);
  }

  {
    const f = fixture();
    f.confirm('保留原数据，另存配对核查结果。');
    const gate = deferred();
    f.setPrepare(() => gate.promise);
    const first = f.click('task-rules-execute');
    assert.equal(f.calls.preparations, 1);
    assert.equal(f.get('task-rules-execute').disabled, true);
    await f.click('task-rules-execute'); // Dispatch even while disabled to exercise the handler lock.
    assert.equal(f.calls.preparations, 1, 'Repeated clicks must not prepare two executions');
    assert.equal(f.calls.sent.length, 0);
    gate.resolve(true);
    await first;
    assert.equal(f.calls.sent.length, 1);
    assert.match(f.calls.sent[0], /清洗规则 v1/);
    assert.equal(f.dialog.open, false);
    assert.equal(f.get('task-rules-execute').disabled, false, 'The preparation lock must release after submission');
  }

  {
    const f = fixture();
    f.confirm('原已确认规则。');
    const gate = deferred();
    f.setPrepare(() => gate.promise);
    const execution = f.click('task-rules-execute');
    f.edit('准备执行期间改变的草稿。');
    gate.resolve(true);
    await execution;
    assert.equal(f.calls.sent.length, 0, 'Changed rules during file preparation must not be sent for execution');
    assert.ok(f.calls.cancelled.includes(f.clean.id));
    assert.match(f.get('task-summary-message').textContent, /变化|修改|重新确认|重新审核/);
    assert.equal(f.get('task-rules-execute').disabled, true);
  }

  {
    const f = fixture();
    f.confirm('原已确认规则。');
    const gate = deferred();
    f.setPrepare(() => gate.promise);
    const execution = f.click('task-rules-execute');
    f.store.addModule('文献挖掘'); // A restore or external module event can change the selection.
    gate.resolve(true);
    await execution;
    assert.equal(f.calls.sent.length, 0, 'An asynchronous preparation must never execute against another selected module');
    assert.ok(f.calls.cancelled.includes(f.clean.id));
  }

  {
    const f = fixture();
    f.confirm('读取当前输入，保留原文件，另存结果。');
    f.setPrepare(async () => false);
    await f.click('task-rules-execute');
    assert.equal(f.calls.sent.length, 0);
    assert.match(f.get('task-summary-message').textContent, /上传|文件|输入/);
    assert.equal(f.get('task-rules-execute').disabled, false, 'Missing input must not leave a permanent execution lock');
    f.setPrepare(async () => { throw new Error('测试文件列表读取失败'); });
    await f.click('task-rules-execute');
    assert.match(f.get('task-summary-message').textContent, /测试文件列表读取失败/);
    assert.equal(f.get('task-rules-execute').disabled, false);
    assert.ok(f.calls.cancelled.includes(f.clean.id));
  }

  {
    const f = fixture();
    f.confirm('按同年同商品同单位配对；贸易比例分母仍待讨论。');
    f.edit('待讨论的草稿：核对比例分母与单边缺失处理。');
    const before = f.browser.TaskManager.rulesForModule(f.clean.id);
    const draft = f.get('task-summary-draft').value;
    f.get('conversation-mode').value = 'notes';
    await f.click('task-rules-discuss');
    assert.deepEqual(f.calls.discussions, [f.clean.id], 'Discussion must explicitly clear any previously prepared write execution');
    assert.equal(f.calls.preparations, 0, 'Discussion must not prepare a cleaning execution');
    assert.equal(f.calls.sent.length, 1);
    assert.equal(f.get('conversation-mode').value, 'ai');
    assert.match(f.calls.sent[0], /只讨论|不执行|不得执行|不运行/);
    assert.match(f.calls.sent[0], /主动|补问|询问|提出/);
    assert.match(f.calls.sent[0], /关键问题|关键缺口|关键.*口径|影响.*口径/);
    assert.match(f.calls.sent[0], /1[–—-]3|1至3|一至三/);
    assert.match(f.calls.sent[0], /待确认|未确认/);
    assert.equal(f.browser.TaskManager.confirmedRules(), before.text, 'Discussion must preserve the confirmed rule');
    assert.equal(f.browser.TaskManager.rulesForModule(f.clean.id).version, before.version, 'Discussion must not confirm a new rule version');
    assert.equal(f.get('task-summary-draft').value, draft, 'Discussion must preserve the existing draft');
    f.setBusy(true);
    f.refresh();
    assert.equal(f.get('task-rules-discuss').disabled, true);
    await f.click('task-rules-discuss');
    assert.equal(f.calls.sent.length, 1, 'A busy task must not send a second discussion request');
    assert.equal(f.calls.preparations, 0);
  }

  {
    const f = fixture();
    f.store.appendMessage(f.clean.id, '只做已明确的检查。', 'user');
    f.click('task-summary-ai');
    assert.deepEqual(f.calls.discussions, [f.clean.id], 'Candidate-rule extraction must force discussion mode, clearing pending execution');
    assert.equal(f.calls.preparations, 0, 'Candidate-rule extraction must not prepare file processing');
    assert.equal(f.get('task-summary-ai').disabled, true);
    assert.match(f.status(), /提取|候选|正在|等待/);
    f.setBusy(true);
    f.store.appendMessage(f.clean.id, '候选规则：保留原值，另存检查报告。', 'assistant');
    assert.equal(f.get('task-summary-ai').disabled, true);
    f.setBusy(false);
    f.refresh();
    assert.equal(f.get('task-summary-ai').disabled, false, 'AI rule extraction must recover when the response transport finishes');
    assert.equal(f.get('task-summary-draft').value, '候选规则：保留原值，另存检查报告。');
    assert.equal(f.browser.TaskManager.confirmedRules(), '', 'Extracted candidates must not become confirmed rules automatically');
    assert.equal(f.get('task-rules-execute').disabled, true);
  }
  console.log('CLEAN_RULES_EXECUTION_TESTS_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
