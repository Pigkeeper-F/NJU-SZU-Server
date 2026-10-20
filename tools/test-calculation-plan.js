#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') { this.tag = tag; this.value = ''; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get firstElementChild() { return this.children[0]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  dispatchEvent(event) { return this.listeners[event.type]?.call(this, event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  querySelector(selector) {
    if (selector === 'label[for="task-summary-draft"]') return this.label;
    return this.children.find(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector) || null;
  }
}
const storage = new Map();
const elements = new Map();
const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
get('task-summary').append(new Element('span'));
const dialog = get('rules-dialog');
dialog.label = new Element('label');
dialog.append(new Element('h2'), new Element('p'), dialog.label);
const sent = [];
let preparations = 0;
let downloads = 0;
const browser = {
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
  ModuleSpace: { isBusy: () => false, sendText: text => { sent.push(text); return true; } },
  CodexUI: { useCodex: () => true, prepareConfirmedExecution: async () => { preparations++; return true; }, cancelPreparedExecution() {}, openDownload: () => { downloads++; return true; } }
};
const context = vm.createContext({ window: browser, document: { getElementById: get, createElement: tag => new Element(tag) }, Event: class { constructor(type) { this.type = type; } }, console });
const load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8'), context);
const click = id => get(id).dispatchEvent({ type: 'click' });
const edit = text => { get('task-summary-draft').value = text; get('task-summary-draft').dispatchEvent({ type: 'input' }); };

(async () => {
  load('store.js');
  const store = browser.Store;
  store.addModule(); store.addModule(); store.addModule();
  const calc = store.addModule();
  store.setModuleMode(calc.id, 'modify');
  store.saveDoc(calc.id, '以前在文档卡审核的方案'); store.approveDoc(calc.id);
  const originalDoc = JSON.stringify(store.getState().modules.find(mod => mod.id === calc.id).doc);
  load('tasks.js');

  // A previously approved independent document must not silently authorize this execution path.
  assert.equal(get('task-summary').firstElementChild.textContent, '计算修改方案');
  assert.equal(browser.TaskManager.confirmedRules(), '');
  assert.equal(get('task-rules-execute').disabled, true);
  const previous = dialog.querySelector('.task-previous-plan');
  assert.equal(previous.hidden, false);
  previous.children.find(node => node.tag === 'button').dispatchEvent({ type: 'click' });
  assert.equal(get('task-summary-draft').value, '以前在文档卡审核的方案');
  assert.equal(browser.TaskManager.confirmedRules(), '');
  assert.equal(JSON.stringify(store.getState().modules.find(mod => mod.id === calc.id).doc), originalDoc);

  click('task-summary-save');
  assert.equal(browser.TaskManager.confirmedRules(), '以前在文档卡审核的方案');
  assert.equal(get('task-rules-execute').disabled, false);
  edit('已讨论的新修改方案：改变参数，另存输出并核查');
  assert.equal(get('task-rules-execute').disabled, true);
  assert.match(get('task-summary-status').textContent, /待重新审核/);
  await click('task-rules-execute');
  assert.equal(preparations, 0);
  assert.equal(sent.length, 0);
  assert.equal(browser.TaskManager.confirmedRules(), '以前在文档卡审核的方案');

  click('task-summary-save');
  assert.match(browser.TaskManager.confirmedRules(), /已讨论的新修改方案/);
  assert.equal(browser.TaskManager.rulesForModule(calc.id).version, 2);
  await click('task-rules-execute');
  assert.equal(preparations, 1);
  assert.match(sent[0], /已审核的计算修改方案 v2/);
  assert.match(sent[0], /不得覆盖原代码/);
  assert.equal(JSON.stringify(store.getState().modules.find(mod => mod.id === calc.id).doc), originalDoc);

  store.setModuleMode(calc.id, 'direct');
  assert.equal(get('task-summary').hidden, true);
  store.setModuleMode(calc.id, 'modify');
  assert.equal(browser.TaskManager.rulesForModule(calc.id).version, 2);
  assert.match(browser.TaskManager.confirmedRules(), /已讨论的新修改方案/);
  const saved = JSON.parse(storage.get('research_tasks_v1'));
  const rules = saved.tasks.find(task => task.id === saved.activeTaskId).rulesByModule[calc.id];
  assert.equal(rules.versions.length, 2);
  assert.equal(rules.confirmed, rules.draft);
  // Plotting uses the same single-plan approval gate and keeps its own versions.
  const drawing = store.addModule('绘图');
  assert.equal(drawing.type, 'plotting');
  assert.equal(get('task-summary').firstElementChild.textContent, '绘图方案');
  assert.equal(browser.TaskManager.confirmedRules(), '');
  assert.equal(get('task-rules-execute').disabled, true);
  edit('折线图；year横轴、value纵轴；PNG、SVG、代码与绘图数据');
  click('task-summary-save');
  assert.equal(browser.TaskManager.rulesForModule(drawing.id).version, 1);
  await click('task-rules-execute');
  assert.match(sent[1], /已审核的绘图方案 v1/);
  edit('改为散点图');
  assert.equal(get('task-rules-execute').disabled, true);
  await click('task-rules-execute');
  assert.equal(sent.length, 2);
  assert.equal(browser.TaskManager.createTask('独立文献任务','literature'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(store.getState().modules.map(mod=>mod.type))),['literature-mining']);
  assert.equal(browser.TaskManager.switchTask(saved.activeTaskId),true);
  assert.equal(browser.TaskManager.rulesForModule(calc.id).version,2);
  assert.equal(browser.TaskManager.rulesForModule(drawing.id).version,1);
  assert.equal(browser.TaskManager.createTask('FAO下载验证','download'),true);
  const download = store.getState().modules[0];
  store.saveDoc(download.id,'FAOSTAT TM，2024，按官方导出地址下载'); store.approveDoc(download.id);
  await click('task-rules-execute');
  assert.equal(downloads,1,'下载规则执行按钮必须进入文件下载器');
  assert.equal(preparations,2,'数据下载不得进入计算文件执行器');
  console.log('CALCULATION_PLAN_TESTS_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
