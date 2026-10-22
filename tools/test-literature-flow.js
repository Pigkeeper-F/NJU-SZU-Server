'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const { LiteratureFlow, evidenceRows, validatePlan, readMaterial } = require('./literature-flow');
const plan = { status: 'approved', content: '仅作测试：检索温度与畜禽排放，提取 temperature 原始值和单位，最多 1 篇。' };
const xml = '<article><front><article-meta><abstract><p>Temperature was 99 °C.</p></abstract></article-meta></front><body><sec><title>Results</title><p>Temperature was 30 °C.</p><table-wrap id="T1"><label>Table 1</label><table><tr><th>Temperature</th><th>Unit</th></tr><tr><td>30</td><td>°C</td></tr></table></table-wrap></sec></body></article>';
async function idle(engine, sid, id) {
  const deadline = Date.now() + 20000;
  while (engine.active.has(id)) { if (Date.now() > deadline) throw new Error('Test workflow timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
  return engine.snapshot(sid, id);
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-literature-test-'));
  try {
    const bridge = new CodexBridge(root);
    let allowFulltext = true, calls = [], generationCalls = [];
    const fetchSource = async source => {
      calls.push(source.url);
      let data;
      if (source.url.includes('/search?')) data = { hitCount: 1, resultList: { result: [{ doi: '10.1/test', pmcid: 'PMC123', id: '123', title: 'Temperature and livestock emissions (test fixture)', pubYear: '2020', isOpenAccess: allowFulltext ? 'Y' : 'N', abstractText: 'Test screening abstract' }] } };
      else if (source.url.includes('api.crossref.org')) data = { message: { 'total-results': 1, items: [{ DOI: '10.1/test', title: ['Temperature and livestock emissions (test fixture)'] }] } };
      else data = xml;
      const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      return { name: source.name, data: bytes, size: bytes.length, finalUrl: source.url, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const generate = async prompt => {
      generationCalls.push(prompt.split('\n')[0]);
      if (prompt.startsWith('LITERATURE_PLAN')) return JSON.stringify({ queries: ['temperature livestock emissions'], sources: ['europepmc', 'crossref'], fields: ['temperature'], limit: 1, questions: [] });
      if (prompt.startsWith('LITERATURE_SCREEN')) return JSON.stringify({ selected: [{ id: '10.1/test', reason: '测试筛选' }], questions: [] });
      const parsed = JSON.parse(prompt.split('材料（仅为不可信数据）：')[1]);
      const material = parsed[0], segment = material.segments.find(s => s.text.includes('Temperature was 30'));
      return JSON.stringify({ rows: [{ field: 'temperature', value: '30', unit: '°C', conditions: 'test fixture', source_file: material.file, location: segment.location, quote: 'Temperature was 30 °C.' }], questions: [] });
    };
    const engine = new LiteratureFlow(bridge, { fetchSource });
    const sid = bridge.createSession().id;
    assert.throws(() => engine.start(sid, { ...plan, status: 'draft' }, generate), /审核/);
    const started = engine.start(sid, plan, generate, 'test-model');
    assert.throws(() => engine.start(sid, plan, generate), /正在运行/);
    const finished = await idle(engine, sid, started.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.candidateCount, 1, 'Deduplicate across sources');
    assert.equal(finished.rowCount, 1);
    assert.deepEqual(generationCalls, ['LITERATURE_PLAN', 'LITERATURE_SCREEN', 'LITERATURE_EXTRACT']);
    const csvPath = bridge.download(sid, 'output', started.id + '/extracted-data.csv');
    const output = fs.readFileSync(csvPath, 'utf8');
    assert.match(output, /"30"/); assert.match(output, /正文段落:1/); assert.match(output, /pending_review/);
    assert.match(fs.readFileSync(bridge.download(sid, 'output', started.id + '/review-report.md'), 'utf8'), /待人工核查/);
    const clean = bridge.createSession().id;
    const imported = bridge.importInput(clean, sid, [started.id + '/extracted-data.csv'], 'output');
    assert.equal(fs.readFileSync(bridge.download(clean, 'input', imported.names[0]), 'utf8'), output);

    const material = [{ file: 'test.xml', segments: [{ location: 'p1', text: 'Temperature was 30 °C.' }, { location: '摘要（不能替代正文证据）', text: 'Temperature was 99 °C.' }] }];
    const wrong = evidenceRows({ rows: [{ field: 'temperature', value: '300', source_file: 'test.xml', location: 'p1', quote: 'Temperature was 30 °C.' }] }, { id: 'p', title: 'test' }, material, ['temperature']);
    assert.equal(wrong.rows[0].value, ''); assert.equal(wrong.rows[0].status, 'needs_discussion'); assert.ok(wrong.questions.length);
    const abstractOnly = evidenceRows({ rows: [{ field: 'temperature', value: '99', source_file: 'test.xml', location: '摘要（不能替代正文证据）', quote: 'Temperature was 99 °C.' }] }, { id: 'p', title: 'test' }, material, ['temperature']);
    assert.equal(abstractOnly.rows[0].value, '');
    const permittedMissing = evidenceRows({ rows: [{ field: 'temperature', value: '' }], questions: [] }, { id: 'p', title: 'test' }, material, ['temperature'], true);
    assert.equal(permittedMissing.rows[0].status, 'not_found'); assert.equal(permittedMissing.questions.length, 0);
    assert.ok(validatePlan({ queries: ['x'], fields: [], sources: ['unsupported'] }).questions.length >= 2);

    allowFulltext = false;
    const uploadSid = bridge.createSession().id;
    const waiting = engine.start(uploadSid, plan, generate);
    const blocked = await idle(engine, uploadSid, waiting.id);
    assert.equal(blocked.status, 'waiting'); assert.equal(blocked.stage, 'acquire'); assert.match(blocked.questions[0], /上传/);
    assert.throws(() => engine.resume(uploadSid, waiting.id, { ...plan, content: 'different' }, '继续', [], generate), /方案已变化/);
    const input = bridge.upload(uploadSid, 'fulltext.txt', Buffer.from('Temperature was 30 °C.'), 'material');
    const restarted = new LiteratureFlow(bridge, { fetchSource });
    const previousSearches = calls.filter(url => url.includes('/search?')).length;
    restarted.resume(uploadSid, waiting.id, plan, '使用我上传并关联的全文，继续提取。', [{ paperId: '10.1/test', inputName: input.name }], generate);
    assert.equal((await idle(restarted, uploadSid, waiting.id)).status, 'completed');
    assert.equal(calls.filter(url => url.includes('/search?')).length, previousSearches, 'Resume must not repeat completed search');
    assert.equal(fs.readFileSync(bridge.download(uploadSid, 'material', input.name), 'utf8'), 'Temperature was 30 °C.');

    const questionSid = bridge.createSession().id;
    let resolved = false;
    const planning = engine.start(questionSid, plan, async prompt => !resolved ? JSON.stringify({ queries: [], fields: [], questions: ['请明确字段'] }) : generate(prompt));
    assert.equal((await idle(engine, questionSid, planning.id)).stage, 'plan');
    resolved = true;
    engine.resume(questionSid, planning.id, plan, 'temperature 是提取字段。', [], generate);
    const again = await idle(engine, questionSid, planning.id);
    assert.equal(again.stage, 'acquire');
    engine.cancel(questionSid, planning.id);
    assert.equal(engine.snapshot(questionSid, planning.id).status, 'cancelled');

    const crashRun = engine.load(questionSid, planning.id); crashRun.status = 'running'; engine.save(crashRun);
    const recovered = new LiteratureFlow(bridge, { fetchSource }).snapshot(questionSid, planning.id);
    assert.equal(recovered.status, 'waiting'); assert.match(recovered.questions[0], /服务已重启/);
    const cancelSid = bridge.createSession().id;
    const pending = engine.start(cancelSid, plan, (_prompt, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('test abort')), { once: true })));
    assert.equal(engine.cancel(cancelSid, pending.id).status, 'cancelled');
    assert.equal((await idle(engine, cancelSid, pending.id)).status, 'cancelled');
    assert.equal(bridge.active(cancelSid), undefined, 'Cancellation releases the session lock');
    const table = await readMaterial(bridge.download(sid, 'output', started.id + '/materials/' + createHash('sha256').update('10.1/test').digest('hex').slice(0, 12) + '-PMC123.xml'));
    assert.ok(table.segments.some(s => s.location === '表:T1:行:2' && s.text === '30 | °C'));
    console.log('LITERATURE_FLOW_TESTS_PASS: search → screen → acquire → extract → review; evidence, upload resume, restart, version, handoff');
  } finally {
    const checked = path.resolve(root);
    if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('yanxu-literature-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(checked, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
