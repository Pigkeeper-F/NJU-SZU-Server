#!/usr/bin/env node
'use strict';

// Exercise production segment actions in memory only. No server, browser,
// research task, file download, or extraction is created or run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const names = ['literatureSegmentSelection', 'createLiteratureSegmentTask', 'openLiteratureSegmentDialog',
  'literatureSegmentSummary', 'continueLiterature', 'literatureResumeStage', 'literaturePanel'];
function fn(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '('); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
class Element {
  constructor(tag, text, className) { Object.assign(this, { tag, tagName: tag.toUpperCase(), textContent: text || '', className: className || '', children: [], style: {}, listeners: {} }); }
  append(...items) { items.forEach(item => { this.children.push(item); item.parent = this; }); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
}
const all = parent => [parent, ...(parent.children || []).flatMap(all)];
const text = parent => all(parent).map(item => item.textContent).join('\n');
const find = (parent, label) => all(parent).find(item => item['aria-label'] === label);
const button = (parent, label) => all(parent).find(item => item.tag === 'button' && item.textContent === label);
const mod = { id: 'module-fixture' };
const fields = [{ key: 'growth', label: '生长指标', meaning: '原文报告的生长指标', unit: '原文单位', valueType: 'number', required: true, conditionKeys: ['指标', '处理组'] }];
const sourceJob = { id: 'source-materials', status: 'completed', stage: 'completed', resumeStage: null, until: 'fulltext',
  materialReplenishment: { parentJobId: 'source-original' }, config: { sources: ['pubmed'], query: 'frozen', fieldDefinitions: [] },
  files: ['fulltext/status.json', 'fulltext/materials.json', 'fulltext/files/P2.pdf'] };
const preview = { sourceJobId: sourceJob.id, sourceLineage: [{ jobId: sourceJob.id, kind: 'materials' }, { jobId: 'source-original', kind: 'research' }],
  schemaSourceJobId: 'source-original', suggestedFields: fields, allowedStages: ['extract', 'validate', 'export'],
  papers: Array.from({ length: 10 }, (_, index) => ({ paperId: 'P' + (index + 1), title: 'Paper ' + (index + 1),
    eligible: { extract: { allowed: index !== 2, reason: index === 2 ? '正文尚不能读取' : '' },
      validate: { allowed: index > 0, reason: index === 0 ? '尚无提取结果' : '' }, export: { allowed: index > 1, reason: index < 2 ? '尚无校验结果' : '' } } })) };
function harness() {
  let current = { literatureJob: copy(sourceJob), literatureConfig: copy(sourceJob.config), literatureUntil: 'fulltext', backend: 'fixture', model: 'fixture' };
  const calls = [], fieldOpens = [], snapshots = [], contexts = [{ id: 'old-context', jobId: sourceJob.id }], body = new Element('body');
  let failCreate = false, globalBusy = false, id = 0;
  const manager = {
    saveActive() { snapshots.push(copy(current)); return { ok: true }; }, list: () => copy(contexts),
    create(input) { contexts.push({ id: 'new-context-' + contexts.length, jobId: null, input: copy(input) }); current = { ...copy(input.seedClient), literatureBusy: false }; return { ok: true }; },
    switch() { throw new Error('Unexpected existing context switch'); }
  };
  const node = (tag, value, className) => new Element(tag, value, className);
  const context = vm.createContext({ root: { crypto: { randomUUID: () => 'request-' + (++id) }, LiteratureUI: { isBusy: () => globalBusy } },
    literatureSegmentDialog: null, task: () => current, saved: { [mod.id]: {} }, node,
    document: { body, dispatchEvent() {} }, CustomEvent: class {}, render() {}, persist() {},
    ModuleSpace: { render() {} }, Store: { getState: () => ({ modules: [mod] }) },
    literatureWorkspaceBusy: () => !!(globalBusy || current.busy || current.literatureBusy || current.literatureJob?.status === 'running'),
    literatureWorkspaceManager: () => manager, literatureStageLabel: stage => ({ extract: '提取参数', validate: '校验参数', export: '导出两表' }[stage] || stage),
    checkLiteratureRuntime: async () => {},
    attachLiteratureJob: (_mod, next) => { current.literatureJob = copy(next); current.literatureConfig = copy(next.config); current.literatureUntil = next.until; contexts.at(-1).jobId = next.id; },
    saveLiteratureFieldDrafts: () => true, openLiteratureFields: () => fieldOpens.push(current.literatureJob.id),
    applyLiteratureJob: (_mod, next) => { current.literatureJob = copy(next); }, watchLiterature: async () => {},
    sameLiteratureConfig: (left, right) => JSON.stringify(left) === JSON.stringify(right), sameLiteratureDeferralConfig: () => false,
    LITERATURE_STAGE_ORDER: ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'], LITERATURE_EXECUTABLE_SOURCES: ['pubmed'],
    LITERATURE_SOURCE_LABELS: { pubmed: 'PubMed' }, LITERATURE_UNTIL_OPTIONS: [['extract', '提取参数'], ['export', '导出两表']],
    newLiteratureSourceOrder: values => values, literatureStatusText: () => '等待确认', literatureStageBar: () => null,
    literatureDeliverables: () => null, literatureHistory: () => node('div'), literatureSource: () => '', panel: node('main'),
    request: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : null; calls.push({ url, body: data });
      if (url.startsWith('/api/literature/segment-preview?')) return copy(preview);
      if (url === '/api/literature/segment-task') {
        if (failCreate) throw new Error('fixture uncertain response');
        const locked = data.fromStage !== 'extract';
        return { id: 'segment-' + data.requestId, status: 'needs_attention', stage: locked ? 'awaiting_segment_confirmation' : 'awaiting_confirmation',
          resumeStage: data.fromStage, until: data.until, config: { ...copy(sourceJob.config), fieldDefinitions: copy(fields) },
          files: ['fulltext/status.json'], segmentTask: { ...data, schemaLocked: locked, createdAt: 'fixture', inputSnapshotSha256: 'fixture' } };
      }
      if (url === '/api/literature/advance') return { ...copy(current.literatureJob), status: 'running' };
      throw new Error('Unexpected request: ' + url);
    }
  });
  vm.runInContext(names.map(fn).join('\n') + '\nglobalThis.subject={' + names.join(',') + '};', context);
  return { subject: context.subject, calls, body, fieldOpens, snapshots, contexts, get current() { return current; },
    setCurrent: value => { current = value; }, failCreate: value => { failCreate = value; }, globalBusy: value => { globalBusy = value; } };
}

async function main() {
  const h = harness(), s = h.subject;
  for (const [fromStage, until, paperIds] of [['extract', 'fulltext', ['P2']], ['validate', 'extract', ['P2']], ['extract', 'export', []], ['extract', 'export', ['P2', 'P2']], ['extract', 'extract', ['P3']], ['export', 'export', ['P1']]]) {
    assert.throws(() => s.literatureSegmentSelection(preview, fromStage, until, paperIds));
  }
  assert.equal(h.calls.length, 0);
  const sourceBytes = JSON.stringify(h.current.literatureJob), sourceContext = copy(h.current);
  await s.openLiteratureSegmentDialog(mod);
  assert.equal(h.calls.length, 1, 'Opening the range dialog only reads a preview');
  const dialog = all(h.body).find(item => item.tag === 'dialog'), form = all(dialog).find(item => item.tag === 'form');
  assert.equal(dialog.open, true); assert.match(text(dialog), /原检索、材料、提取和导出保留/);
  assert.equal(all(dialog).filter(item => item.type === 'checkbox' && item.checked).length, 0, 'Do not silently choose the first five');
  assert.equal(find(dialog, '选择文献 P3').disabled, true); assert.match(text(dialog), /正文尚不能读取/);
  for (const paperId of ['P2', 'P4', 'P6', 'P8', 'P10']) { const check = find(dialog, '选择文献 ' + paperId); check.checked = true; check.onchange(); }
  assert.match(text(dialog), /已选择 5 篇/);
  const until = find(dialog, '结束阶段'); until.value = 'export'; until.onchange();
  find(dialog, '初始提取表头').value = 'blank';
  h.failCreate(true); await form.onsubmit({ preventDefault() {} });
  assert.equal(dialog.open, true, 'Uncertain response keeps range and request identity for retry');
  const firstRequest = h.calls.find(call => call.url === '/api/literature/segment-task').body;
  h.failCreate(false); await form.onsubmit({ preventDefault() {} });
  const creates = h.calls.filter(call => call.url === '/api/literature/segment-task');
  assert.deepEqual(creates[1].body, firstRequest, 'An uncertain response is retried with exactly the same idempotency key');
  assert.deepEqual(firstRequest.paperIds, ['P2', 'P4', 'P6', 'P8', 'P10']);
  assert.equal(firstRequest.fromStage, 'extract'); assert.equal(firstRequest.until, 'export');
  assert.equal(h.current.literatureJob.status, 'needs_attention'); assert.equal(h.current.literatureJob.stage, 'awaiting_confirmation');
  assert.deepEqual(copy(h.current.literatureConfirmDrafts), [], 'Blank mode starts with a genuinely empty editable draft');
  assert.equal(h.fieldOpens.length, 1); assert.equal(h.contexts.length, 2); assert.equal(dialog.open, false);
  assert.equal(JSON.stringify(h.snapshots[0].literatureJob), sourceBytes);
  for (const key of ['literatureConfig', 'literatureUntil', 'backend', 'model']) assert.deepEqual(h.snapshots[0][key], sourceContext[key], 'The source workspace keeps ' + key);
  assert.ok(!h.calls.some(call => /advance|search|replenish/.test(call.url)), 'Creation never starts a stage or modifies the source material task');
  const beforeGate = h.calls.length; await s.continueLiterature(mod);
  assert.equal(h.calls.length, beforeGate, 'Extract segments must wait for the fresh field gate');

  // Validate/export copy locked schemas and require the explicit range action.
  for (const fromStage of ['validate', 'export']) {
    const locked = harness(), ids = ['P4', 'P8'];
    await locked.subject.createLiteratureSegmentTask(mod, { preview, paperIds: ids, fromStage, until: 'export', requestId: fromStage, fieldMode: 'blank' });
    assert.equal(locked.fieldOpens.length, 0); assert.equal(locked.current.literatureJob.segmentTask.schemaLocked, true);
    assert.deepEqual(locked.current.literatureJob.config.fieldDefinitions, fields);
    const before = locked.calls.length;
    await locked.subject.continueLiterature(mod); assert.equal(locked.calls.length, before);
    await locked.subject.continueLiterature(mod, { until: 'validate', confirmSegment: true }); assert.equal(locked.calls.length, before, 'A confirm action cannot change the fixed end');
    const panel = new Element('main'); locked.subject.literaturePanel(mod, locked.current, panel);
    assert.equal(button(panel, '确认配置并检索'), undefined); assert.equal(button(panel, '从对话整理规则'), undefined);
    assert.equal(find(panel, '本次运行到'), undefined); assert.equal(button(panel, '设置提取字段').hidden, true);
    assert.match(text(panel), /字段只读沿用已有提取结果/); assert.match(text(panel), /P4、P8/);
    const start = button(panel, '确认范围并开始执行'); assert.ok(start); assert.equal(locked.calls.length, before, 'Rendering does not run the range');
    await start.onclick();
    assert.deepEqual(locked.calls.at(-1), { url: '/api/literature/advance', body: { id: locked.current.literatureJob.id, until: 'export', confirmSegment: true } });
    const after = locked.calls.length; await locked.subject.continueLiterature(mod, { confirmSegment: true }); assert.equal(locked.calls.length, after, 'Old range action cannot replay once running');
    locked.current.literatureJob.status = 'cancelled';
    const stoppedPanel = new Element('main'); locked.subject.literaturePanel(mod, locked.current, stoppedPanel);
    const resume = button(stoppedPanel, '继续本次执行范围'); assert.ok(resume);
    const beforeStopped = locked.calls.length; await locked.subject.continueLiterature(mod);
    assert.equal(locked.calls.length, beforeStopped, 'Stopped locked range still requires an explicit scope action');
    await resume.onclick();
    assert.equal(locked.calls.at(-1).body.confirmSegment, true); assert.equal(locked.calls.at(-1).body.until, 'export');
  }
  const reused = harness(); await reused.subject.createLiteratureSegmentTask(mod, { preview, paperIds: ['P2'], fromStage: 'extract', until: 'extract', requestId: 'reuse', fieldMode: 'reuse' });
  assert.deepEqual(copy(reused.current.literatureConfirmDrafts), fields, 'Suggested source fields are editable drafts, not fresh approval');
  assert.notEqual(reused.current.literatureConfirmDrafts, fields); assert.equal(reused.current.literatureJob.status, 'needs_attention');
  reused.current.literatureJob.status = 'cancelled'; reused.current.literatureJob.stage = 'cancelled'; reused.current.literatureJob.segmentTask.fieldsConfirmed = false;
  const cancelledPanel = new Element('main'); reused.subject.literaturePanel(mod, reused.current, cancelledPanel);
  const confirmStopped = button(cancelledPanel, '核对表头后继续'); assert.ok(confirmStopped);
  const beforeUnconfirmed = reused.calls.length; await reused.subject.continueLiterature(mod);
  assert.equal(reused.calls.length, beforeUnconfirmed, 'Cancellation must not bypass fresh field confirmation');
  await confirmStopped.onclick(); assert.equal(reused.fieldOpens.length, 2); assert.equal(reused.calls.length, beforeUnconfirmed);
  reused.current.literatureJob.segmentTask.fieldsConfirmed = true;
  await reused.subject.continueLiterature(mod);
  assert.equal(reused.calls.at(-1).url, '/api/literature/advance'); assert.equal(reused.calls.at(-1).body.until, 'extract');
  assert.equal(reused.calls.at(-1).body.confirmations, undefined, 'Already-confirmed stopped segments resume with the saved schema');
  for (const busy of ['running', 'local', 'global']) {
    const blocked = harness();
    if (busy === 'running') blocked.current.literatureJob.status = 'running';
    if (busy === 'local') blocked.current.literatureBusy = true;
    if (busy === 'global') blocked.globalBusy(true);
    await blocked.subject.openLiteratureSegmentDialog(mod);
    await blocked.subject.createLiteratureSegmentTask(mod, { preview, paperIds: ['P2'], fromStage: 'extract', until: 'extract', requestId: 'blocked' });
    assert.equal(blocked.calls.length, 0); assert.equal(blocked.contexts.length, 1);
  }
  console.log('LITERATURE_SEGMENT_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
