#!/usr/bin/env node
'use strict';
// Memory-only modal tests. No user database, browser, model or research files.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/literature-confirmed-plan.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const all = el => [el, ...el.children.flatMap(all)];
const text = el => all(el).map(item => item.textContent).join('\n');
const btn = (el, label) => all(el).find(item => item.tagName === 'BUTTON' && item.textContent === label);
const field = (el, label) => all(el).find(item => item.attributes['aria-label'] === label);
class Element {
  constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), textContent: '', children: [], attributes: {}, listeners: {}, value: '', disabled: false, hidden: false }); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  set innerHTML(_) { throw new Error('Untrusted HTML must never be inserted'); }
}
const ENTRIES = [{ id: 'cnki-p', database: 'cnki', line: 'production', label: '知网生产', query: 'TI=(温度)', reportedCount: 3887, method: '专业检索后导出题录' },
  { id: 'cnki-e', database: 'cnki', line: 'emission', label: '知网排放', queries: ['TI=(水温)', { query: 'TI=(热应激)' }], notes: '已确认词表' },
  { id: 'scopus-p', database: 'scopus', line: 'production', label: 'Scopus 生产', query: 'TITLE(temperature)', reportedCount: 3353 }];
const RECORDS = [
  { paperId: 'pending-pdf', title: '<img src=x onerror=alert(1)>研究', decision: 'pending', reason: '温度比较待核', inputHash: 'input-1', policyHash: 'policy-1', pdfPath: 'fulltext/pending/a b.pdf', abstract: '<script>bad()</script>' },
  { paperId: 'pending-missing', title: '尚未取得全文', decision: 'pending', reason: '缺摘要', inputHash: 'input-2', policyHash: 'policy-1' },
  { paperId: 'included', title: '温度与生长', decision: 'include', reason: '有比较组', inputHash: 'input-3', policyHash: 'policy-1', pdfPath: 'fulltext/c.pdf' },
  { paperId: 'excluded', title: '纯综述', decision: 'exclude', reason: '非原始研究', inputHash: 'input-4', policyHash: 'policy-1', exclusionRule: '文献类型' }
];
function harness() {
  const document = { head: new Element('head'), body: new Element('body'), createElement: tag => new Element(tag),
    getElementById(id) { return [...all(this.head), ...all(this.body)].find(el => el.id === id); } };
  const calls = [], prepared = [], changes = [], copied = [];
  let records = clone(RECORDS), entries = clone(ENTRIES), handler = null;
  const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => clone(data) });
  const fetch = async (url, options = {}) => {
    const call = { url, method: options.method || 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
    if (handler) { const result = handler(call); if (result) return result; }
    const parsed = new URL(url, 'http://fixture.invalid');
    if (parsed.pathname === '/api/literature/confirmed-plan') return response({ entries });
    if (parsed.pathname === '/api/literature/confirmed-plan/prepare') return response({ job: { id: 'prepared-job' } });
    if (parsed.pathname === '/api/literature/screening') return response({ records, counts: { pending: 2, include: 1, exclude: 1 } });
    if (parsed.pathname === '/api/literature/screening/manual') {
      const record = records.find(r => r.paperId === call.body.paperId); Object.assign(record, { decision: call.body.decision, reason: call.body.reason }); return response({ saved: true });
    }
    throw new Error('Unexpected request ' + url);
  };
  const root = { navigator: { clipboard: { writeText: async value => copied.push(value) } } };
  vm.runInNewContext(source, { window: root, document, fetch, console });
  const options = { onPrepared: (job, entry) => prepared.push({ job: clone(job), entry: clone(entry) }), onChanged: result => changes.push(clone(result)) };
  return { document, ui: root.LiteratureConfirmedPlan, calls, prepared, changes, copied, response, options,
    open: extra => root.LiteratureConfirmedPlan.open({ ...options, ...extra }), handler: value => { handler = value; },
    records: value => { records = value; }, entries: value => { entries = value; } };
}
function card(dialog, id) { return all(dialog).find(el => el.attributes['data-paper-id'] === id); }
function fill(form, choice = 'include') {
  field(form, '全文选择').value = choice; field(form, '全文选择').onchange();
  field(form, '判断理由').value = '同日粮的温度对照，有目标排放数据。'; field(form, '原文页码 / 表图位置').value = '第 3 页，表 2';
  field(form, '已核对全文').checked = true;
}
const submit = form => form.onsubmit({ preventDefault() {} });
async function main() {
  const h = harness(), dialog = await h.open();
  assert.equal(dialog.open, true); assert.equal(h.calls.length, 1, 'Without a job only confirmed-plan is read');
  assert.match(text(dialog), /3887.*历史命中数/); assert.match(text(dialog), /不开始检索/);
  assert.equal(h.calls[0].headers['X-Workbench'], '1');
  await btn(dialog, '复制检索式').onclick(); assert.deepEqual(h.copied, ['TI=(温度)']);
  const select = field(dialog, '生产 / 排放方案'); select.value = 'cnki-e'; select.onchange();
  assert.match(text(dialog), /TI=\(水温\)[\s\S]*TI=\(热应激\)/);
  await btn(dialog, '准备此库任务').onclick();
  assert.deepEqual(h.calls.find(c => c.method === 'POST').body, { presetId: 'cnki-e' });
  assert.equal(h.prepared.length, 1); assert.equal(h.prepared[0].entry.id, 'cnki-e');
  assert.match(text(dialog), /尚未启动/); assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(h.calls.every(c => !/\/(run|search|fulltext|extract|download)\b/.test(c.url)), 'Preparing cannot execute retrieval or extraction');
  btn(dialog, '篇关摘与全文筛选').onclick();
  assert.equal(btn(dialog, '待定 (2)').attributes['aria-pressed'], 'true');
  assert.equal(card(dialog, 'pending-pdf').children.find(el => el.tagName === 'H3').textContent, RECORDS[0].title);
  assert.equal(all(dialog).some(el => el.tagName === 'IMG' || el.tagName === 'SCRIPT'), false, 'Titles and abstracts remain inert text');
  const pdf = all(card(dialog, 'pending-pdf')).find(el => el.tagName === 'A');
  assert.equal(pdf.href, '/api/literature/download?id=prepared-job&name=fulltext%2Fpending%2Fa%20b.pdf');
  assert.equal(pdf.rel, 'noopener noreferrer');
  assert.equal(btn(card(dialog, 'pending-missing'), '核对全文后选择'), undefined, 'Missing PDF cannot open fulltext decision form');
  btn(card(dialog, 'pending-pdf'), '核对全文后选择').onclick();
  const form = all(dialog).find(el => el.tagName === 'FORM'), posts = h.calls.filter(c => c.method === 'POST').length;
  await submit(form); assert.equal(h.calls.filter(c => c.method === 'POST').length, posts, 'Incomplete evidence never posts');
  fill(form, 'exclude'); await submit(form); assert.equal(h.calls.filter(c => c.method === 'POST').length, posts, 'Exclusion requires corresponding rule');
  fill(form); await submit(form);
  const manual = h.calls.find(c => c.url.endsWith('/manual'));
  assert.deepEqual(manual.body, { id: 'prepared-job', paperId: 'pending-pdf', decision: 'include', reason: '同日粮的温度对照，有目标排放数据。', exclusionRule: '',
    expectedInputHash: 'input-1', expectedPolicyHash: 'policy-1', fulltextReviewed: true, sourceReference: { path: 'fulltext/pending/a b.pdf', pages: '第 3 页，表 2' } });
  assert.equal(h.changes.length, 1); assert.equal(h.changes[0].jobId, 'prepared-job'); assert.equal(h.changes[0].decision, 'include');
  assert.equal(btn(dialog, '普通候选 (2)').textContent, '普通候选 (2)'); assert.equal(card(dialog, 'pending-pdf'), undefined, 'Saved item leaves pending tab');
  btn(dialog, '普通候选 (2)').onclick(); assert.ok(card(dialog, 'pending-pdf'));
  field(dialog, '筛选区查找').value = 'included'; field(dialog, '筛选区查找').oninput(); assert.equal(card(dialog, 'pending-pdf'), undefined); assert.ok(card(dialog, 'included'));

  // Preserve manual draft on optimistic-concurrency rejection; no automatic retry.
  const conflict = harness(), cd = await conflict.open({ job: { id: 'existing-job' } });
  conflict.handler(c => c.url.endsWith('/manual') ? conflict.response({ error: '版本变化' }, 409) : null);
  btn(card(cd, 'pending-pdf'), '核对全文后选择').onclick(); const cf = all(cd).find(el => el.tagName === 'FORM'); fill(cf);
  await submit(cf); assert.match(text(cf), /本次选择没有保存/); assert.equal(btn(cf, '保存人工选择').disabled, true);
  assert.equal(field(cf, '判断理由').value, '同日粮的温度对照，有目标排放数据。'); assert.equal(conflict.changes.length, 0);
  await submit(cf); assert.equal(conflict.calls.filter(c => c.url.endsWith('/manual')).length, 1);
  await btn(cd, '刷新记录').onclick(); assert.equal(all(cd).some(el => el.tagName === 'FORM'), false);

  // Closure and overlapping loads cannot replace another modal; mutations cannot be double-posted.
  const busy = harness(), bd = await busy.open(); let finish;
  busy.handler(c => c.url.endsWith('/prepare') ? new Promise(resolve => { finish = resolve; }) : null);
  const prepButton = btn(bd, '准备此库任务'), saving = prepButton.onclick(); await prepButton.onclick();
  assert.equal(busy.ui.close(), false); assert.equal(bd.open, true);
  assert.equal(busy.calls.filter(c => c.url.endsWith('/prepare')).length, 1);
  finish(busy.response({ job: { id: 'once' } })); await saving; assert.equal(busy.prepared.length, 1); busy.ui.close();
  const late = harness(); let resolveOld;
  late.handler(c => c.url.endsWith('/confirmed-plan') ? new Promise(resolve => { resolveOld = resolve; }) : null);
  const opening = late.open(); const old = late.document.body.children.find(el => el.tagName === 'DIALOG'); late.ui.close();
  late.handler(null); const fresh = await late.open({ job: 'fresh-job' }); resolveOld(late.response({ entries: [{ ...ENTRIES[0], label: 'STALE OLD RESULT' }] })); await opening;
  assert.equal(old.open, false); assert.doesNotMatch(text(fresh), /STALE OLD RESULT/); assert.equal(late.document.head.children.length, 1);

  // Invalid file paths, absent hashes, and absent query cannot silently enable a decision/start.
  const bad = harness(); bad.records([
    { ...RECORDS[0], paperId: 'outside', pdfPath: '../outside.pdf' },
    { ...RECORDS[0], paperId: 'url', pdfPath: 'https://evil.example/file.pdf' },
    { ...RECORDS[0], paperId: 'unversioned', inputHash: '' }
  ]); bad.entries([{ ...ENTRIES[0], query: '' }]); const badDialog = await bad.open({ job: 'job' });
  assert.equal(all(badDialog).filter(el => el.tagName === 'A').length, 1, 'Only the bounded relative path gets a download link');
  assert.equal(btn(badDialog, '核对全文后选择'), undefined); assert.equal(btn(badDialog, '准备此库任务').disabled, true);
  const paged = harness(); paged.records(Array.from({ length: 43 }, (_, i) => ({ ...RECORDS[1], paperId: 'page-' + i }))); const pd = await paged.open({ job: 'job' });
  assert.equal(all(pd).filter(el => el.tagName === 'ARTICLE').length, 20); btn(pd, '下一页').onclick(); assert.ok(card(pd, 'page-20'));
  btn(pd, '下一页').onclick(); assert.equal(all(pd).filter(el => el.tagName === 'ARTICLE').length, 3); assert.equal(btn(pd, '下一页').disabled, true);
  const unscreened = harness(); unscreened.records([{ ...RECORDS[1], decision: '', paperId: 'not-screened' }]); const ud = await unscreened.open({ job: 'job' });
  assert.ok(btn(ud, '待定 (0)')); assert.equal(card(ud, 'not-screened'), undefined, 'Missing decision never masquerades as an authorised pending PDF record');
  btn(ud, '未筛选 (1)').onclick(); assert.ok(card(ud, 'not-screened'));

  const offline = harness(); offline.handler(() => { throw new Error('离线测试'); }); const od = await offline.open({ job: 'job' });
  assert.match(text(od), /离线测试/); offline.handler(null); await btn(od, '重新读取方案').onclick(); await btn(od, '重新读取筛选记录').onclick();
  assert.ok(btn(od, '准备此库任务')); assert.ok(btn(od, '待定 (2)'));
  console.log('confirmed-plan UI: preparation, three-state screening, evidence/hashes, concurrency, XSS, failure and pagination passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
