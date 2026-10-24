#!/usr/bin/env node
'use strict';

// Render the production download section in a tiny DOM fixture. This test has
// no server, browser, account, filesystem-write, or literature-run side effects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'codex.js'), 'utf8');

function functionSource(name) {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'Missing production function: ' + name);
  return source.slice(start, end + 4);
}

class Element {
  constructor(tag, text, className) {
    this.tag = tag;
    this.textContent = text || '';
    this.className = className || '';
    this.children = [];
    this.open = false;
    this.isConnected = false;
  }
  append(...children) { this.children.push(...children); }
}
const all = parent => [parent, ...(parent.children || []).flatMap(all)];
const summary = section => section.children.find(child => child.tag === 'summary');
const constantsStart = source.indexOf('  const LITERATURE_STAGE_ORDER');
const constantsEnd = source.indexOf('  function literatureStageLabel', constantsStart);
assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
const context = vm.createContext({
  node: (tag, text, className) => new Element(tag, text, className)
});
vm.runInContext(source.slice(constantsStart, constantsEnd) + '\n'
  + ['literatureFileLabel', 'literatureFileGroups', 'literatureDeliverables', 'literatureStageLabel', 'literatureStageBar'].map(functionSource).join('\n')
  + '\nglobalThis.render = literatureDeliverables; globalThis.renderStages = literatureStageBar;', context);

const files = [
  'run_config.json', 'candidates.json', 'candidates.csv',
  'dedupe/dedupe.json', 'dedupe/dedupe.csv',
  'fulltext/status.json', 'fulltext/materials.json', 'fulltext/files/PMID-002.txt',
  ...Array.from({ length: 12 }, (_, i) => 'extraction/inputs/PMID-' + i + '.json'),
  'validation/validation.json', 'validation/validation.md',
  'export/literature.csv', 'export/literature.xlsx',
  'export/parameters.csv', 'export/parameters.xlsx', 'export/export_report.md'
];
const job = { id: 'fixture/& new task', status: 'completed', files,
  counters: { materialsIncomplete: 10, fulltextUnavailable: 6, fulltextAttention: 0, parameterRows: 259 } };
const original = JSON.stringify(job);
const box = context.render(job);
const sections = box.children.filter(child => child.tag === 'details');
assert.equal(sections.length, 6);
assert.equal(summary(sections[0]).textContent, '最终导出文件 · 5 个');
assert.equal(sections[0].open, true, 'Final output files are easy to find without expanding intermediate artifacts');
for (const section of sections.slice(1)) {
  assert.equal(section.open, false, 'Intermediate files are collapsed initially, including small groups');
  assert.match(summary(section).textContent, / · \d+ 个$/);
}
assert.equal(summary(sections[1]).textContent, '检索与配置 · 3 个');
assert.ok(sections.slice(1).some(section => summary(section).textContent === '提取产物 · 12 个'));
const more = all(box).find(element => element.className === 'literature-deliverable-more');
assert.equal(more.open, false);
assert.equal(summary(more).textContent, '展开其余 6 个文件');

// Every original file remains accessible with its exact job and path encoded;
// highlighting a review/status link may add another access point, never hide it.
const anchors = all(box).filter(element => element.tag === 'a');
const linked = new Set();
for (const anchor of anchors) {
  const url = new URL(anchor.href, 'http://fixture.invalid');
  assert.equal(url.pathname, '/api/literature/download');
  assert.equal(url.searchParams.get('id'), job.id);
  linked.add(url.searchParams.get('name'));
}
assert.deepEqual([...linked].sort(), [...files].sort());
assert.equal(JSON.stringify(job), original, 'Pure rendering must not mutate an old job or its saved material list');

const notices = box.children.filter(element => element.className === 'literature-deliverable-notice');
assert.equal(notices.length, 2);
assert.ok(notices.every(element => element.tag !== 'details'), 'Material/review notices remain visible outside collapsed sections');
assert.ok(all(notices[0]).some(element => element.textContent.includes('材料不完整 10 篇') && element.textContent.includes('全文待补 6 篇')));
assert.ok(all(notices[1]).some(element => element.textContent.includes('自动校验完成不代表已人工核查')));
assert.ok(all(notices[1]).some(element => element.title === 'validation/validation.md'));
assert.ok(!all(notices[1]).some(element => /259.*待审/.test(element.textContent)), 'Parameter totals cannot be presented as a pending-review count');

// A user click is recorded synchronously, before native details toggling or a
// polling rerender. Jobs/groups are independent; detached toggle events cannot
// overwrite the current group state after it has been rendered again.
const group = (parent, text) => parent.children.find(element => element.tag === 'details' && summary(element).textContent.startsWith(text));
summary(group(box, '检索与配置')).onclick();
const afterClick = context.render(job);
const opened = group(afterClick, '检索与配置');
assert.equal(opened.open, true, 'Rerender between click and native toggle preserves the intended expansion');
assert.equal(group(afterClick, '去重产物').open, false, 'Expanding one group does not expand another');
opened.open = false; opened.ontoggle();
assert.equal(group(context.render(job), '检索与配置').open, true, 'Detached toggle notifications cannot reset remembered expansion');
opened.isConnected = true; opened.ontoggle();
assert.equal(group(context.render(job), '检索与配置').open, false, 'A connected native toggle is recorded');
summary(group(afterClick, '最终导出文件')).onclick();
assert.equal(group(context.render(job), '最终导出文件').open, false, 'A user may keep final exports collapsed too');
summary(more).onclick();
assert.equal(all(context.render(job)).find(element => element.className === 'literature-deliverable-more').open, true, 'Nested long-file expansion also survives polling');
const other = context.render({ ...job, id: 'independent-job' });
assert.equal(group(other, '最终导出文件').open, true);
assert.equal(group(other, '检索与配置').open, false, 'A new job starts with its own default state');

const legacy = context.render({ id: 'legacy', files: ['candidates.csv'] });
assert.equal(legacy.children.length, 1);
assert.equal(legacy.children[0].open, false);
assert.equal(all(legacy).filter(element => element.className === 'literature-deliverable-notice').length, 0,
  'A legacy job without evidence must not invent missing-material or review counts');
const unverified = context.render({ id: 'not-reviewed', files: ['fulltext/status.json'], counters: { materialsUnverified: 2 } });
assert.ok(all(unverified).some(element => element.textContent.includes('补充材料未核查 2 篇')));
assert.equal(context.render({ id: 'empty', files: [] }), null);

const stageJob = { ...job, resumeStage: 'extract', until: 'export',
  stages: { discover: 'done', dedupe: 'done', fulltext: 'done', extract: 'pending', validate: 'pending', export: 'pending' },
  counters: { ...job.counters, candidates: 10, fulltextFetched: 3, extractedPapers: 3, fulltextPdf: 0, fulltextHtml: 3, customCount: 42 } };
const stageOriginal = JSON.stringify(stageJob);
const stages = context.renderStages(stageJob);
const meta = stages.children.find(element => element.className === 'literature-stage-meta');
for (const text of ['下一阶段：提取参数', '本次运行到：导出两表', '候选 10', '已获取全文 3', '已提取论文 3', '参数行 259']) {
  assert.ok(meta.textContent.includes(text), 'Summary keeps essential progress: ' + text);
}
assert.ok(!meta.textContent.includes('材料不完整') && !meta.textContent.includes('网页正文文本') && !meta.textContent.includes('customCount'), 'Detailed counters are not squeezed into the summary line');
const statistics = stages.children.find(element => element.className === 'literature-stage-statistics');
assert.equal(statistics.open, false);
assert.equal(summary(statistics).textContent, '详细统计 · ' + Object.keys(stageJob.counters).length + ' 项');
for (const text of ['材料不完整 10', '待补充 6', 'PDF正文 0', '网页正文文本 3', 'customCount 42']) {
  assert.ok(all(statistics).some(element => element.textContent === text), 'Full counters remain available, including zeros and unknown legacy labels: ' + text);
}
summary(statistics).onclick();
assert.equal(context.renderStages(stageJob).children.find(element => element.className === 'literature-stage-statistics').open, true);
statistics.open = false; statistics.ontoggle();
assert.equal(context.renderStages(stageJob).children.find(element => element.className === 'literature-stage-statistics').open, true, 'Detached statistics toggle cannot reset expansion');
statistics.isConnected = true; statistics.ontoggle();
assert.equal(context.renderStages(stageJob).children.find(element => element.className === 'literature-stage-statistics').open, false);
assert.equal(JSON.stringify(stageJob), stageOriginal);
assert.equal(JSON.stringify(job), original);
assert.equal(context.renderStages({ id: 'no-stages' }), null);

// Font size and stylesheet precedence are checked on the rendered page; CSS
// string matching cannot establish whether text is actually readable.
console.log('LITERATURE_DELIVERABLES_COLLAPSE_TESTS_PASS');
