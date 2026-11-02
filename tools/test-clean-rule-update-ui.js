#!/usr/bin/env node
'use strict';
// Exercise the real TaskManager update/execution entry under isolated browser
// state. No live browser, network, cleaning run or user storage is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../js/tasks.js'), 'utf8');
function fn(name) {
  const start = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(start, name);
  return source.slice(start.index, source.indexOf('\n  }', start.index) + 4);
}
const copy = value => JSON.parse(JSON.stringify(value));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const before = '已确认 A 规则，保留 13 列及 80 行；两项技术待确认。';
const after = '已确认 A 规则，保留 13 列及 80 行；输入已绑定，异常仅报告或停止。';
const basePatch = { id: 'update-a-1', sessionId: 'session-a', beforeText: before, afterText: after,
  beforeSha256: sha(before), afterSha256: sha(after), createdAt: '2026-10-27T12:00:00Z',
  authorization: { id: 'user-current-turn', text: '同步规则并保留旧版本，直接在平台点执行。' },
  binding: { name: 'original.csv', sha256: 'a'.repeat(64), rows: 80 } };
function fixture() {
  const module = { id: 'clean', type: 'clean-data', messages: [{ role: 'user', text: '原始讨论不可覆盖。' }], doc: { content: '独立方案保留。' }, run: { id: 'old-run' } };
  const other = { draft: '其他模块草稿', confirmed: '其他模块规则', versions: [{ text: '其他模块规则' }] };
  const task = { id: 'project-a', rulesByModule: { clean: { draft: before, confirmed: before, versions: [{ text: before, at: '2026-10-26T00:00:00Z' }] }, other } };
  const index = { activeTaskId: task.id, tasks: [task] }, state = { activeModuleId: 'clean', modules: [module] };
  let busy = false, storageOk = true, sid = 'session-a', saves = 0, renders = 0;
  const messages = [], memory = {}, persisted = [];
  const root = { Store: { getState: () => state },
    CodexUI: { cleanSessionId: () => sid },
    CleanExecutionPlan: { resolve: (text, binding) => text === before && binding?.name === 'original.csv' && binding?.sha256 === 'a'.repeat(64) ? { text: after } : null } };
  const ctx = vm.createContext({ root, current: () => task, index, switching: false, pendingRules: null, startingExecution: null, cleanVerificationStage: null,
    busy: () => busy, saveIndex() { saves++; if (storageOk) persisted.push(copy(index)); return storageOk; }, memory, INDEX_KEY: 'research_tasks_v1',
    showMessage: value => messages.push(value), render() { renders++; }, Date, JSON, Error });
  vm.runInContext(fn('applyCleanRuleUpdate') + '\nglobalThis.applyUpdate = applyCleanRuleUpdate;', ctx);
  return { ctx, task, module, other, state, root, index, memory, messages, persisted,
    apply: patch => ctx.applyUpdate('clean', patch || copy(basePatch)),
    setBusy: value => { busy = value; }, setStorage: value => { storageOk = value; }, setSid: value => { sid = value; },
    get saves() { return saves; }, get renders() { return renders; } };
}
async function main() {
  const h = fixture(), originalModule = copy(h.module), originalOther = copy(h.other), originalHistory = copy(h.task.rulesByModule.clean.versions);
  const result = h.apply();
  assert.equal(result.applied, true); assert.equal(result.version, 2); assert.equal(h.saves, 1); assert.equal(h.renders, 1);
  const rules = h.task.rulesByModule.clean;
  assert.equal(rules.confirmed, after); assert.equal(rules.draft, after); assert.deepEqual(rules.versions.slice(0, 1), originalHistory);
  assert.equal(rules.versions[1].ruleUpdateId, basePatch.id); assert.deepEqual(rules.versions[1].authorization, basePatch.authorization);
  assert.deepEqual(rules.versions[1].binding, basePatch.binding); assert.equal(rules.versions[1].previousSha256, sha(before));
  assert.deepEqual(h.module, originalModule, 'Discussion, doc and prior result are untouched');
  assert.deepEqual(h.task.rulesByModule.other, originalOther, 'Other module rules are untouched');
  assert.match(h.messages[0], /可直接点击/);
  assert.equal(h.apply().unchanged, true); assert.equal(h.saves, 1, 'A repeated refresh never adds another version');
  const conflict = copy(basePatch); conflict.afterText = after + '修改';
  assert.equal(h.apply(conflict).applied, false);
  const legacy = fixture(); legacy.task.rulesByModule.clean.versions = [{ text: '更早规则' }];
  assert.equal(legacy.apply().version, 3); assert.equal(legacy.task.rulesByModule.clean.versions[1].text, before);
  assert.equal(legacy.task.rulesByModule.clean.versions[1].recoveredPreviousConfirmed, true);

  // Real frozen sources retain a final newline, but confirmRules() stores
  // textarea.value.trim(). Test the actual adapter and exact A fixture rather
  // than letting a synthetic one-line rule hide that boundary mismatch.
  const executionPlan = require('../js/clean-execution-plan');
  const frozenA = fs.readFileSync(path.join(__dirname, 'fixtures/fbsh80-a-plan.md'), 'utf8').replace(/\r\n?/g, '\n');
  assert.match(frozenA, /\n$/);
  const bindingA = { sourceName: '3f7c827b-FBSH_1992_Afghanistan_练习样本.csv',
    inputName: '3f7c827b-FBSH_1992_Afghanistan_练习样本.csv',
    sha256: '0247cc2079a04125980ccf9510a4e3d56960734633012ef6181dddd65965f2c0' };
  const resolvedA = executionPlan.resolve(frozenA, bindingA);
  assert.ok(resolvedA);
  const patchA = { ...copy(basePatch), beforeText: frozenA, afterText: resolvedA.text,
    beforeSha256: sha(frozenA), afterSha256: sha(resolvedA.text), binding: bindingA };
  for (const [label, approved] of [
    ['trimmed browser approval', frozenA.trim()],
    ['CRLF browser approval', frozenA.trim().replace(/\n/g, '\r\n')]
  ]) {
    const real = fixture(); real.root.CleanExecutionPlan = executionPlan;
    real.task.rulesByModule.clean = { confirmed: approved, draft: approved,
      versions: [{ text: approved, at: '2026-10-26T00:00:00Z' }] };
    assert.equal(real.apply(copy(patchA)).applied, true, label);
    assert.equal(real.task.rulesByModule.clean.confirmed, resolvedA.text, label);
    assert.equal(real.task.rulesByModule.clean.versions[0].text, approved, 'Original serialized approval is preserved');
    assert.equal(real.apply(copy(patchA)).unchanged, true, label);
  }
  const recoverA = fixture(); recoverA.root.CleanExecutionPlan = executionPlan;
  recoverA.task.rulesByModule.clean = { confirmed: frozenA.trim(), draft: frozenA.trim(),
    versions: [{ text: frozenA }] };
  assert.equal(recoverA.apply(copy(patchA)).version, 3);
  assert.equal(recoverA.task.rulesByModule.clean.versions[0].text, frozenA);
  assert.equal(recoverA.task.rulesByModule.clean.versions[1].text, frozenA.trim(), 'Unrecorded browser approval is preserved exactly');
  const changedA = fixture(); changedA.root.CleanExecutionPlan = executionPlan;
  const editedA = frozenA.trim().replace('不翻译、不换算', '不翻译、允许换算');
  changedA.task.rulesByModule.clean = { confirmed: editedA, draft: editedA, versions: [{ text: editedA }] };
  const changedBefore = copy(changedA.task);
  assert.equal(changedA.apply(copy(patchA)).reason, 'approved-rules-changed');
  assert.deepEqual(changedA.task, changedBefore, 'Body edits remain protected');
  for (const [label, alter] of [
    ['different session', h => h.setSid('other-session')],
    ['different active module', h => { h.state.activeModuleId = 'other'; }],
    ['different module type', h => { h.module.type = 'literature'; }],
    ['confirmed rules edited', h => { h.task.rulesByModule.clean.confirmed = '新的研究口径'; }],
    ['draft edited', h => { h.task.rulesByModule.clean.draft = before + '\n研究者正在编辑'; }],
    ['busy', h => h.setBusy(true)],
    ['pending extraction', h => { h.ctx.pendingRules = {}; }],
    ['starting run', h => { h.ctx.startingExecution = {}; }],
    ['switching task', h => { h.ctx.switching = true; }],
    ['staged unconfirmed draft', h => { h.ctx.cleanVerificationStage = {}; }],
    ['missing adapter', h => { delete h.root.CleanExecutionPlan; }]
  ]) {
    const denied = fixture(); alter(denied); const previous = copy(denied.task);
    assert.equal(denied.apply().applied, false, label); assert.equal(denied.saves, 0, label); assert.deepEqual(denied.task, previous, label);
  }
  for (const [label, change] of [
    ['mismatched session', p => { p.sessionId = 'session-b'; }],
    ['wrong source', p => { p.beforeText += '新规则'; }],
    ['wrong target', p => { p.afterText += '增加换算'; }],
    ['wrong binding', p => { p.binding.sha256 = 'b'.repeat(64); }],
    ['missing binding', p => { delete p.binding; }],
    ['missing authorization', p => { p.authorization = null; }],
    ['invalid digest', p => { p.beforeSha256 = 'not-a-hash'; }]
  ]) {
    const denied = fixture(), patch = copy(basePatch), previous = copy(denied.task); change(patch);
    assert.equal(denied.apply(patch).applied, false, label); assert.equal(denied.saves, 0, label); assert.deepEqual(denied.task, previous, label);
  }
  const full = fixture(), previous = copy(full.task); full.setStorage(false);
  assert.equal(full.apply().reason, 'storage-failed'); assert.deepEqual(full.task, previous);
  assert.deepEqual(JSON.parse(full.memory.research_tasks_v1), full.index, 'The memory fallback also rolls back');
  assert.equal(full.messages.length, 0); assert.equal(full.renders, 0);

  // A click arriving before the background refresh must await rule sync before
  // capturing the execution text/version. Errors or navigation never execute.
  async function executionFixture(mode) {
    let currentText = before, version = 1, prepares = 0, sent = 0, syncs = 0;
    const module = { id: 'clean', type: 'clean-data' }, state = { activeModuleId: 'clean', modules: [module] }, index = { activeTaskId: 'project-a' };
    const notice = [], order = [], elements = new Map();
    const $ = id => { if (!elements.has(id)) elements.set(id, { value: '', close() {}, dispatchEvent() {} }); return elements.get(id); };
    const root = { Store: { getState: () => state }, ModuleSpace: { sendText() { sent++; order.push('send'); return true; } },
      CodexUI: { useCodex: () => true, async syncCleanRuleUpdate() {
        syncs++; order.push('sync'); if (mode === 'error') throw new Error('绑定文件已变化');
        currentText = after; version = 2; if (mode === 'switch') index.activeTaskId = 'project-b';
      }, async prepareConfirmedExecution() { prepares++; order.push('prepare'); return true; }, cancelPreparedExecution() { order.push('cancel'); } } };
    const context = vm.createContext({ root, index, busy: () => false, pendingRules: null, startingExecution: null,
      confirmedRules: () => currentText, ruleVersion: () => version, rulesFor: () => ({ draft: currentText }), current: () => ({}),
      hasEditableRules: () => true, isPlotting: () => false, refreshControls() {}, render() {}, showMessage: v => notice.push(v), $, Event: class {} });
    vm.runInContext(fn('executeRules') + '\nglobalThis.execute = executeRules;', context);
    await context.execute(); return { syncs, prepares, sent, notice, order };
  }
  const executed = await executionFixture('normal'); assert.equal(executed.syncs, 1); assert.deepEqual(executed.order, ['sync', 'prepare', 'send']); assert.equal(executed.sent, 1);
  for (const mode of ['error', 'switch']) { const held = await executionFixture(mode); assert.equal(held.prepares, 0); assert.equal(held.sent, 0); assert.match(held.notice.join('\n'), /未启动清洗/); }
  console.log('PASS clean rule update UI: authorised version append, session/draft guards, durable rollback, idempotence, click-time sync; no live execution.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
