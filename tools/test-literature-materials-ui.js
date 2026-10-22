'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf('  async function ' + name + '(') >= 0 ? source.indexOf('  async function ' + name + '(') : source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0); return source.slice(start, source.indexOf('\n  }', start) + 4);
}
class Element {
  constructor(tag, text, className) { this.tag = tag; this.textContent = text || ''; this.className = className || ''; this.children = []; this.style = {}; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  showModal() { this.visible = true; }
  close() { this.visible = false; this.onclose?.(); }
  remove() { this.removed = true; }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
async function main() {
  const body = new Element('body'), calls = [], job = { id: 'paused-job', status: 'needs_attention' }, before = JSON.stringify(job);
  const inventory = { schema: 1, legacy: false, papers: [{ paper_id: 'CNKI-001', title: 'Paper A', main_pdf_status: 'missing',
    supplement_check: { status: 'none_declared', reason: 'Original paper explicitly declares no supplements' }, materials: [
      { material_id: 'S1', role: 'supplement', label: 'Table S1', filename: 'table.xlsx', format: 'xlsx', size: 2048,
        download_status: 'downloaded', download_reason: 'Original download was retried', read_status: 'unsupported', read_reason: 'Saved original format', available: true, path: 'fulltext/materials/CNKI-001/table.xlsx' }
    ] }, { paper_id: 'PMID-002', title: 'Paper B', main_pdf_status: 'pending', supplement_check: { status: 'uninspected' }, materials: [] }] };
  const context = vm.createContext({ task: () => ({ literatureJob: job }), node: (tag, text, cls) => new Element(tag, text, cls), document: { body },
    request: async (...args) => { calls.push(args); return inventory; } });
  const names = ['closeLiteratureMaterials', 'renderLiteratureMaterials', 'openLiteratureMaterials'];
  vm.runInContext('let literatureMaterialsDialog=null;\n' + names.map(functionSource).join('\n') + '\nglobalThis.subject={openLiteratureMaterials};', context);
  await context.subject.openLiteratureMaterials({ id: 'module-fixture' });
  assert.deepEqual(calls, [['/api/literature/materials?id=paused-job']]);
  assert.equal(JSON.stringify(job), before, 'view never changes task status');
  const dialog = body.children[0], nodes = flatten(dialog), text = nodes.map(n => n.textContent).join('\n');
  assert.equal(dialog.attributes['aria-label'], '每篇材料清单'); assert.ok(dialog.visible);
  assert.match(text, /取得正文不代表补材齐全/); assert.match(text, /缺少正文PDF/);
  assert.match(text, /原文明确无补充材料/); assert.match(text, /补材尚未检查/);
  assert.match(text, /table.xlsx/); assert.match(text, /2048 字节/); assert.match(text, /暂不支持读取原格式/);
  assert.match(text, /保存问题：Original download was retried/);
  const links = nodes.filter(n => n.tag === 'a'); assert.equal(links.length, 1);
  assert.equal(links[0].href, '/api/literature/download?id=paused-job&name=fulltext%2Fmaterials%2FCNKI-001%2Ftable.xlsx');
  assert.ok(!calls.some(([url]) => /advance|search|retry|review-fulltext|runtime/.test(url)));
  console.log('LITERATURE_MATERIALS_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
