#!/usr/bin/env node
'use strict';

// Production download discussion controls, with in-memory DOM/state only.
// This does not open a browser, contact a service, or touch research data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fn(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source); assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n  }', match.index) + 4);
}
function node(tag, text, className) {
  return { tag, textContent: text || '', className: className || '', children: [], append(...items) { this.children.push(...items); }, setAttribute(key, value) { this[key] = value; } };
}
const elements = parent => [parent, ...parent.children.flatMap(elements)];
function fixture(options = {}) {
  const mod = { id: 'download-fixture', type: 'download-data', messages: [{ role: 'user', text: '已有确认范围' }],
    doc: { status: 'approved', content: '# 已审核下载方案\n下载已确认年份。', approvedAt: 'fixture' },
    run: { status: 'confirmed', at: 'fixture', artifacts: [{ name: 'old.csv', size: 42 }] } };
  const current = { busy: false, sourceJob: { id: 'previous', status: 'completed' } };
  const saved = { [mod.id]: { download: { confirmed: true, text: mod.doc.content, files: [{ name: 'old.csv' }], failures: [] } } };
  let active = mod.id, globallyBusy = false, callback = options.callback || (() => true), rendering = 0;
  const calls = [], state = { modules: [mod], get activeModuleId() { return active; } };
  const moduleSpace = { isBusy: () => globallyBusy };
  if (!options.missingInterface) moduleSpace.discussDownloadVerification = id => { calls.push(id); return callback(id); };
  const forbidden = () => { throw new Error('Discussion must not download, approve, execute, or hand off'); };
  const context = vm.createContext({ root: { ModuleSpace: moduleSpace, DownloadProfessionalRules: require('../js/download-professional-rules') }, Store: { getState: () => state, saveDoc: forbidden, approveDoc: forbidden, confirmRun: forbidden },
    task: () => current, saved, node, render: () => { rendering++; }, request: forbidden, openDownload: forbidden, startSourceDownload: forbidden, handoffDownload: forbidden });
  vm.runInContext(fn('discussDownloadVerification') + '\n' + fn('downloadVerificationControls')
    + '\nglobalThis.subject={discussDownloadVerification,downloadVerificationControls};', context);
  return { mod, current, saved, calls, subject: context.subject, setActive: id => { active = id; }, setBusy: value => { globallyBusy = value; },
    setCallback: value => { callback = value; }, get renders() { return rendering; } };
}
async function main() {
  const h = fixture(), originalDoc = JSON.stringify(h.mod.doc), originalRun = JSON.stringify(h.mod.run), originalSaved = JSON.stringify(h.saved), originalMessages = JSON.stringify(h.mod.messages);
  const controls = h.subject.downloadVerificationControls(h.mod, h.current), button = elements(controls).find(item => item.tag === 'button');
  assert.equal(button.textContent, '讨论核验方法'); assert.equal(button['aria-label'], '讨论下载核验方法'); assert.equal(button.disabled, false);
  assert.match(elements(controls).map(item => item.textContent).join('\n'), /同一份下载方案/);
  assert.match(button.title, /不会开始下载或自动确认/); assert.equal(h.calls.length, 0, 'Rendering does not request or save anything');
  assert.match(elements(controls).map(item => item.textContent).join('\n'), /0 项可自动检查，1 项需讨论或判断/);
  const preview = fixture(); preview.mod.doc.content += '\n\n### 专业核验规则\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| P01 | Unit | 允许值 | t | 全部 | 本合成数据单位约定 |';
  const previewText = elements(preview.subject.downloadVerificationControls(preview.mod, preview.current)).map(item => item.textContent).join('\n');
  assert.match(previewText, /1 项可自动检查，0 项需讨论或判断/); assert.match(previewText, /不表示已经检查通过/); assert.equal(preview.calls.length, 0);
  assert.equal(await button.onclick(), true); assert.deepEqual(h.calls, [h.mod.id]);
  assert.equal(JSON.stringify(h.mod.doc), originalDoc, 'The control must preserve the already-approved plan');
  assert.equal(JSON.stringify(h.mod.run), originalRun); assert.equal(JSON.stringify(h.saved), originalSaved); assert.equal(JSON.stringify(h.mod.messages), originalMessages);
  assert.equal(h.current.downloadVerificationOpening, false);
  assert.equal(h.subject.downloadVerificationControls({ ...h.mod, type: 'literature-mining' }, h.current), null);
  assert.equal(await h.subject.discussDownloadVerification({ ...h.mod, type: 'calculation' }), false); assert.equal(h.calls.length, 1);

  for (const lock of ['local-busy', 'source-running', 'global-busy', 'opening']) {
    const blocked = fixture();
    if (lock === 'local-busy') blocked.current.busy = true;
    if (lock === 'source-running') blocked.current.sourceJob.status = 'running';
    if (lock === 'global-busy') blocked.setBusy(true);
    if (lock === 'opening') blocked.current.downloadVerificationOpening = true;
    const control = blocked.subject.downloadVerificationControls(blocked.mod, blocked.current);
    assert.equal(elements(control).find(item => item.tag === 'button').disabled, true, lock);
    assert.equal(await blocked.subject.discussDownloadVerification(blocked.mod), false, 'Click-time busy guard: ' + lock); assert.equal(blocked.calls.length, 0);
  }
  const changed = fixture(), staleButton = elements(changed.subject.downloadVerificationControls(changed.mod, changed.current)).find(item => item.tag === 'button');
  changed.setActive('another-module'); assert.equal(await staleButton.onclick(), false); assert.equal(changed.calls.length, 0, 'A stale control cannot target a different active module');
  const missing = fixture({ missingInterface: true }); assert.equal(await missing.subject.discussDownloadVerification(missing.mod), false);
  assert.match(missing.current.error, /入口尚未载入/); assert.equal(missing.calls.length, 0, 'Do not fall back to a download or execution action');
  const rejected = fixture({ callback: () => false }); assert.equal(await rejected.subject.discussDownloadVerification(rejected.mod), false);
  assert.match(rejected.current.error, /无法打开/); assert.equal(rejected.current.downloadVerificationOpening, false);
  const failed = fixture({ callback: () => { throw new Error('fixture draft conflict'); } });
  assert.equal(await failed.subject.discussDownloadVerification(failed.mod), false); assert.equal(failed.current.error, 'fixture draft conflict');
  assert.equal(failed.mod.doc.status, 'approved'); assert.equal(failed.current.downloadVerificationOpening, false);

  let release;
  const waiting = fixture({ callback: () => new Promise(resolve => { release = resolve; }) });
  const pending = waiting.subject.discussDownloadVerification(waiting.mod);
  assert.equal(waiting.current.downloadVerificationOpening, true);
  assert.equal(await waiting.subject.discussDownloadVerification(waiting.mod), false); assert.equal(waiting.calls.length, 1, 'Do not open duplicate discussion drafts while awaiting an action');
  release(true); assert.equal(await pending, true); assert.equal(waiting.current.downloadVerificationOpening, false);
  // The visible control is rendered before the file disclosure, so it is
  // available before a download or file record exists.
  const renderStart = source.indexOf('  function render()');
  const discussionIndex = source.indexOf('panel.append(downloadVerificationControls(mod, t))', renderStart);
  const fileDisclosure = source.indexOf("const files = node('details', undefined, 'codex-attachments')", renderStart);
  assert.ok(discussionIndex > renderStart && discussionIndex < fileDisclosure, 'The entry is not hidden in files or conditional on an existing download');
  assert.deepEqual(plain(waiting.mod.doc), plain(h.mod.doc));
  console.log('DOWNLOAD_VERIFICATION_CONTROLS_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
