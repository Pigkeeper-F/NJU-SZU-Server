'use strict';

// Tools/Tests for tools/literature-extract.js (extract 阶段 Node 半：CodexBridge 适配器)。
// 运行：node tools/test-literature-extract.js（需要本机 python；用 mock bridge，不联网、不调用真实模型）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildExtractPrompt, parseExtractionJson, runExtractStage } = require('./literature-extract');

const python = process.env.WORKBENCH_PYTHON || 'python';
const FIELDS = [
  { key: 'soc', label: 'SOC', meaning: '土壤有机碳含量', unit: 'g/kg', valueType: 'number', required: true,
    allowedRange: { min: 0, max: 600 }, conditionKeys: ['site', 'treatment', 'year'] },
  { key: 'crop', label: '作物', meaning: '作物类型', unit: '', valueType: 'text', required: false },
];

function makeJob(dir, { confirmations = true, fields = FIELDS, maxChars = 120000 } = {}) {
  fs.mkdirSync(path.join(dir, 'fulltext', 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run_config.json'), JSON.stringify({
    version: 2, query: 'soil organic carbon', sources: ['google-scholar'],
    extraction: { maxCharsPerPaper: maxChars, model: 'gpt-6-luna' }, limits: { extract: 120 },
  }, null, 2));
  if (confirmations) {
    fs.writeFileSync(path.join(dir, 'confirmations.json'), JSON.stringify({
      records: [{ at: '2026-10-15T00:00:00Z', by: 'researcher', kind: 'fieldDefinitions', fields, note: '' }],
    }, null, 2));
  }
  fs.writeFileSync(path.join(dir, 'fulltext', 'files', 'GSC-001.txt'),
    'Site A, 2018 maize field. Soil organic carbon was 12.4 g/kg in the 0-30 cm layer (Table 3).');
  fs.writeFileSync(path.join(dir, 'fulltext', 'status.json'), JSON.stringify({
    version: 1,
    items: [
      { paper_id: 'GSC-001', title: 'A study', doi: '10.1/a', source_url: 'https://example.org/a',
        fulltext_url: 'https://example.org/a', kind: 'html', status: 'fetched_html',
        path: 'fulltext/files/GSC-001.txt', size: 120, retrieved_at: '2026-10-15T00:00:00Z',
        evidence_level: 'fulltext_html', reason: '' },
      { paper_id: 'GSC-002', title: 'B study', doi: '', source_url: 'https://example.org/b',
        fulltext_url: '', kind: 'pdf', status: 'fetched_pdf',
        path: 'fulltext/files/GSC-002.pdf', size: 0, retrieved_at: '2026-10-15T00:00:00Z',
        evidence_level: 'fulltext_pdf', reason: '' },
    ],
    counts: { total: 2 },
  }, null, 2));
}

function cannedResult(paperId) {
  return {
    paper_id: paperId, source_pdf: `${paperId}.txt`, status: 'ok',
    classification_reason: '田间试验报告了 SOC',
    rows: [{
      row_id: `${paperId}-R001`, field: 'soc', value_raw: '12.4', unit_raw: 'g/kg',
      value_normalized: 12.4, unit_normalized: 'g/kg', conversion: null,
      evidence: { where: 'Table 3', quote: 'SOC was 12.4 g/kg', kind: 'table' },
      conditions: { site: 'A', treatment: 'CK', year: '2018' }, provenance: '',
    }],
    warnings: [], skip_reason: '',
  };
}

function mockBridge(reply) {
  const calls = [];
  const jobs = new Map();
  let counter = 0;
  return {
    calls,
    createSession() { return { id: 'lit-test-session', files: [] }; },
    async run(sessionId, messages, instructions, execute, model, moduleType, moduleMode) {
      const id = `job-${++counter}`;
      calls.push({ sessionId, messages, instructions, execute, model, moduleType, moduleMode, id });
      const text = typeof reply === 'function' ? reply(calls.length, messages.map(m => m.content).join('\n')) : reply;
      jobs.set(id, { id, status: 'completed', text, error: null });
      return { id, sessionId, status: 'running' };
    },
    snapshot(id) { return jobs.get(id); },
    async cancel() {},
  };
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('parseExtractionJson tolerates fences and rejects junk', () => {
  const payload = cannedResult('GSC-001');
  assert.deepEqual(parseExtractionJson(JSON.stringify(payload)), payload);
  assert.deepEqual(parseExtractionJson('```json\n' + JSON.stringify(payload) + '\n```'), payload);
  assert.deepEqual(parseExtractionJson('前言\n' + JSON.stringify(payload) + '\n后记'), payload);
  assert.equal(parseExtractionJson('not json at all'), null);
  assert.equal(parseExtractionJson(''), null);
  assert.equal(parseExtractionJson(null), null);
  assert.equal(parseExtractionJson(JSON.stringify({ paper_id: 'x' })), null);
  assert.equal(parseExtractionJson(JSON.stringify({ ...payload, rows: 'nope' })), null);
});

test('buildExtractPrompt carries schema, instructions version and full text', () => {
  const bundle = {
    paper_id: 'GSC-001', title: 'A study', doi: '10.1/a', source_url: 'https://example.org/a',
    instructions_version: 'extract-contract-v1', field_definitions: FIELDS, condition_keys: ['site'],
    fulltext: { kind: 'html', path: 'fulltext/files/GSC-001.txt', text: 'SOC 12.4 g/kg', chars: 11, truncated: false },
  };
  const prompt = buildExtractPrompt(bundle);
  assert.match(prompt, /paper_id: GSC-001/);
  assert.match(prompt, /禁推断/);
  assert.match(prompt, /figure-extracted from/);
  assert.match(prompt, /"key": "soc"/);
  assert.match(prompt, /SOC 12\.4 g\/kg/);
  assert.match(prompt, /GSC-001\.txt/);
});

test('missing confirmations pauses at awaiting_confirmation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-gate-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir, { confirmations: false });
    const events = [];
    const bridge = mockBridge(JSON.stringify(cannedResult('GSC-001')));
    const result = await runExtractStage({ bridge, jobDir, config: readJson(path.join(jobDir, 'run_config.json')), python, onEvent: e => events.push(e) });
    assert.equal(result.ok, false);
    assert.equal(result.paused, true);
    assert.equal(bridge.calls.length, 0);
    const attention = events.find(e => e.type === 'attention');
    assert.ok(attention, 'attention 事件缺失');
    assert.equal(attention.stage, 'awaiting_confirmation');
    assert.match(attention.message, /确认主题参数字段含义与单位/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extract stage writes results, degrades the unreadable paper and passes --check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-ok-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir);
    const events = [];
    const bridge = mockBridge((count, prompt) => {
      const paperId = /paper_id: (\S+)/.exec(prompt)[1];
      return '```json\n' + JSON.stringify(cannedResult(paperId)) + '\n```';
    });
    const config = readJson(path.join(jobDir, 'run_config.json'));
    const result = await runExtractStage({ bridge, jobDir, config, python, onEvent: e => events.push(e) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.extracted, 1);
    assert.equal(result.skipped, 1);

    const extracted = readJson(path.join(jobDir, 'extraction', 'GSC-001.json'));
    assert.equal(extracted.paper_id, 'GSC-001');
    assert.equal(extracted.rows[0].field, 'soc');
    const degraded = readJson(path.join(jobDir, 'extraction', 'GSC-002.json'));
    assert.equal(degraded.status, 'skipped');
    assert.ok(degraded.skip_reason.length > 0, '降级篇必须带 skip_reason');

    const report = readJson(path.join(jobDir, 'extraction', 'check_report.json'));
    assert.deepEqual([report.bundles, report.ok, report.failed], [2, 2, 0]);
    assert.equal(report.degraded.length, 1);

    assert.equal(bridge.calls.length, 1, '只有正文可用的那一篇才调用模型');
    assert.equal(bridge.calls[0].moduleType, 'literature-mining');
    assert.equal(bridge.calls[0].execute, false);
    assert.equal(bridge.calls[0].model, 'gpt-6-luna');
    assert.equal(bridge.calls[0].sessionId, 'lit-test-session');
    assert.match(bridge.calls[0].instructions, /禁推断/);

    const final = events.filter(e => e.type === 'result').pop();
    assert.equal(final.stage, 'extraction');
    assert.equal(final.count, 1);
    assert.equal(final.counts.skipped, 1);
    assert.ok(final.files.includes('extraction/GSC-001.json'));
    assert.ok(final.files.includes('extraction/check_report.json'));
    assert.ok(events.some(e => e.type === 'stage' && e.stage === 'extraction'));
    assert.ok(!events.some(e => e.type === 'error'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unparsable model reply degrades the paper instead of blocking the batch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-junk-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir);
    const events = [];
    const bridge = mockBridge('模型没有按要求输出 JSON，只有一段散文。');
    const result = await runExtractStage({
      bridge, jobDir, config: readJson(path.join(jobDir, 'run_config.json')), python, onEvent: e => events.push(e),
    });
    assert.equal(result.ok, true);
    assert.equal(result.extracted, 0);
    assert.equal(result.skipped, 2);
    const degraded = readJson(path.join(jobDir, 'extraction', 'GSC-001.json'));
    assert.equal(degraded.status, 'skipped');
    assert.match(degraded.skip_reason, /待补充/);
    const report = readJson(path.join(jobDir, 'extraction', 'check_report.json'));
    assert.equal(report.failed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume skips the model call when usable results already exist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-resume-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir);
    const config = readJson(path.join(jobDir, 'run_config.json'));
    const first = mockBridge((count, prompt) => JSON.stringify(cannedResult(/paper_id: (\S+)/.exec(prompt)[1])));
    await runExtractStage({ bridge: first, jobDir, config, python, onEvent: () => {} });
    assert.equal(first.calls.length, 1);
    const second = mockBridge('unused');
    const result = await runExtractStage({ bridge: second, jobDir, config, python, onEvent: () => {} });
    assert.equal(result.ok, true);
    assert.equal(second.calls.length, 0, '结果已存在时不应重复调用模型');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schema change forces bundle rebuild and re-extraction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-stale-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir);
    const config = readJson(path.join(jobDir, 'run_config.json'));
    const first = mockBridge((count, prompt) => JSON.stringify(cannedResult(/paper_id: (\S+)/.exec(prompt)[1])));
    await runExtractStage({ bridge: first, jobDir, config, python, onEvent: () => {} });
    assert.equal(first.calls.length, 1);

    const changed = [FIELDS[0], { ...FIELDS[1], unit: '%' }];
    fs.writeFileSync(path.join(jobDir, 'confirmations.json'), JSON.stringify({
      records: [
        { at: '2026-10-15T00:00:00Z', by: 'researcher', kind: 'fieldDefinitions', fields: FIELDS, note: '' },
        { at: '2026-10-16T00:00:00Z', by: 'researcher', kind: 'fieldDefinitions', fields: changed, note: '' },
      ],
    }, null, 2));

    const second = mockBridge((count, prompt) => JSON.stringify(cannedResult(/paper_id: (\S+)/.exec(prompt)[1])));
    const result = await runExtractStage({ bridge: second, jobDir, config, python, onEvent: () => {} });
    assert.equal(result.ok, true);
    assert.equal(second.calls.length, 1, 'schema 变化后必须重跑该篇提取');
    const bundle = readJson(path.join(jobDir, 'extraction', 'inputs', 'GSC-001.json'));
    assert.equal(bundle.field_definitions[1].unit, '%');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing python or bridge reports a single error event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-i4-js-err-'));
  try {
    const jobDir = path.join(root, 'job');
    makeJob(jobDir);
    const config = readJson(path.join(jobDir, 'run_config.json'));
    const events = [];
    const bridge = mockBridge('irrelevant');
    const result = await runExtractStage({
      bridge, jobDir, config, python: 'definitely-not-a-python-binary', onEvent: e => events.push(e),
    });
    assert.equal(result.ok, false);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    const missingBridge = await runExtractStage({ bridge: null, jobDir, config, python, onEvent: () => {} });
    assert.equal(missingBridge.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function main() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  if (failed) {
    console.error(`${failed} test(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('LITERATURE_EXTRACT_TESTS_PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
