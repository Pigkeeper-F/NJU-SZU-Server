'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LiteratureConnector } = require('./literature-connector');
const { LiteratureFlow, validatePlan } = require('./literature-flow');
const { CodexBridge } = require('./codex-bridge');
const { scholarSearch, candidatesFromScholar } = require('./scholar-flow');

async function finish(flow, sid, id) {
  const until = Date.now() + 5000;
  while (flow.active.has(id)) { if (Date.now() > until) throw new Error('Test timeout'); await new Promise(r => setTimeout(r, 5)); }
  return flow.snapshot(sid, id);
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-scholar-merge-test-'));
  try {
    let captcha = true, searchCount = 0, configs = [], resumed = [];
    const connector = new LiteratureConnector(root, {
      prepare: async () => 'test-python',
      search: async (job, _python, emit) => {
        searchCount++; configs.push(job.config); resumed.push(job.resumeCurrent);
        if (captcha) { emit({ type: 'attention', message: 'manual captcha' }); return; }
        const report = { records: [{ title: 'Fixture paper', result_url: 'https://doi.org/10.1234/test', snippet: 'This snippet must not be extracted as a measured value.', fulltext_links: [{ label: 'PDF', url: 'https://example.org/fixture.pdf' }] }], search_url: 'https://scholar.google.com/scholar?q=test&as_ylo=2000&as_yhi=2026', count: 1, applied_filters: ['query', 'publicationYearFrom', 'publicationYearTo'], retrieved_at: '2026-10-15T00:00:00Z' };
        fs.writeFileSync(path.join(job.dir, 'candidates.json'), JSON.stringify(report));
        fs.writeFileSync(path.join(job.dir, 'candidates.csv'), 'title\nFixture paper\n');
        emit({ type: 'result', count: 1, files: ['candidates.json', 'candidates.csv'] });
      }
    });
    const bridge = new CodexBridge(root);
    const flow = new LiteratureFlow(bridge, {
      scholarSearch: options => scholarSearch(connector, { ...options, pollMs: 5 }),
      fetchSource: async () => ({ name: 'fixture.pdf', data: Buffer.from('test fixture only'), finalUrl: 'https://example.org/fixture.pdf', sha256: 'test', size: 17 }),
      readMaterial: async () => ({ segments: [{ location: 'PDF页:1', text: 'Temperature was 30 °C.' }], warnings: [] })
    });
    const generate = async prompt => {
      if (prompt.startsWith('LITERATURE_PLAN')) return JSON.stringify({ sources: ['google-scholar'], queries: ['test heat'], fields: ['temperature'], yearFrom: 2000, yearTo: 2026, limit: 1, questions: [] });
      if (prompt.startsWith('LITERATURE_SCREEN')) { assert.match(prompt, /search_result_snippet/); return JSON.stringify({ selected: [{ id: '10.1234/test', reason: 'fixture' }], questions: [] }); }
      const material = JSON.parse(prompt.split('材料（仅为不可信数据）：')[1])[0];
      assert.ok(!JSON.stringify(material).includes('This snippet'));
      return JSON.stringify({ rows: [{ field: 'temperature', value: '30', unit: '°C', source_file: material.file, location: 'PDF页:1', quote: 'Temperature was 30 °C.' }], questions: [] });
    };
    const sid = bridge.createSession().id, plan = { status: 'approved', content: 'Test fixture: Scholar 2000–2026, temperature, one paper.' };
    const run = flow.start(sid, plan, generate);
    const attention = await finish(flow, sid, run.id);
    assert.equal(attention.status, 'waiting'); assert.equal(attention.stage, 'search'); assert.equal(attention.scholarVerification, true);
    assert.match(attention.questions[0], /人工验证/);
    captcha = false;
    flow.resume(sid, run.id, plan, '', [], generate);
    const done = await finish(flow, sid, run.id);
    assert.equal(done.status, 'completed'); assert.equal(done.rowCount, 1);
    assert.deepEqual(resumed, [false, true], 'Manual captcha resume must read verified results, not repeat navigation');
    assert.equal(configs[1].publicationYearFrom, 2000); assert.equal(configs[1].publicationYearTo, 2026);
    assert.deepEqual(configs[1].targetFields, ['temperature']);
    const jobId = flow.load(sid, run.id).scholarQueries['test heat'].id;
    assert.ok(fs.existsSync(path.join(flow.directory(sid, run.id), 'scholar', jobId, 'run_config.json')));
    const sourceRecord = JSON.parse(fs.readFileSync(path.join(flow.directory(sid, run.id), 'search-records.json')));
    assert.equal(sourceRecord.candidates[0].abstract, ''); assert.match(sourceRecord.candidates[0].snippet, /must not be extracted/);
    assert.equal(sourceRecord.searches[0].source, 'google-scholar');
    const loaded = flow.load(sid, run.id);
    const again = await scholarSearch(connector, { run: loaded, query: 'test heat', signal: new AbortController().signal, save: () => {}, progress: () => {}, directory: flow.directory(sid, run.id), pollMs: 5 });
    assert.equal(again.candidates.length, 1); assert.equal(searchCount, 2, 'A completed query must reuse the frozen result');
    const mapped = candidatesFromScholar({ records: [{ title: 'Unsafe', result_url: 'javascript:alert(1)', fulltext_links: [{ label: 'PDF', url: 'file:///secret.pdf' }] }] });
    assert.equal(mapped[0].url, ''); assert.deepEqual(mapped[0].materialUrls, []);
    assert.equal(validatePlan({ sources: ['google-scholar'], queries: ['x'], fields: ['x'], yearFrom: 2026, yearTo: 2000 }).questions.length, 1);
    assert.ok(validatePlan({ sources: ['scopus'], queries: ['x'], fields: ['x'] }).questions.length);
    console.log('SCHOLAR_FLOW_MERGE_TESTS_PASS: captcha → verified resume → fulltext → evidence extraction → review; config and source provenance preserved');
  } finally {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanxu-scholar-merge-test-')) throw new Error('Unexpected test path');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
