'use strict';

// 文献路由 HTTP 测试（第二阶段扩展）：advance/jobs 新路由、download 新 MIME 与登记校验、守卫零回归。
// 用仓库根 .workbench 内的人工 fake job 验证；结束后清理，不留测试产物。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8213;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const FAKE_DIR = path.join(ROOT, '.workbench', 'literature', FAKE_ID);

async function ready() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(BASE + '/index.html')).status === 200) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

function writeFakeJob() {
  fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(FAKE_DIR, 'export'), { recursive: true });
  fs.mkdirSync(path.join(FAKE_DIR, 'validation'), { recursive: true });
  fs.writeFileSync(path.join(FAKE_DIR, 'run_config.json'), JSON.stringify({ version: 2, topic: 'http 测试', query: 'q', sources: ['google-scholar'], limit: 10 }, null, 2) + '\n');
  fs.writeFileSync(path.join(FAKE_DIR, 'export', 'parameters.csv'), '\ufeffrow_id\nGSC-001-R001\n');
  fs.writeFileSync(path.join(FAKE_DIR, 'export', 'literature.xlsx'), Buffer.from('PK\x03\x04stub', 'binary'));
  fs.writeFileSync(path.join(FAKE_DIR, 'validation', 'validation.md'), '# 待审清单\n');
  fs.writeFileSync(path.join(FAKE_DIR, 'job.json'), JSON.stringify({
    id: FAKE_ID, status: 'completed', stage: 'completed', message: '已导出 1 篇文献、1 个参数行',
    count: 1, config: { query: 'q' },
    files: ['run_config.json', 'export/parameters.csv', 'export/literature.xlsx', 'validation/validation.md'],
    events: [], error: null,
    stages: { discover: 'done', dedupe: 'done', fulltext: 'done', extract: 'done', validate: 'done', export: 'done' },
    resumeStage: null, until: 'export', counters: { parameterRows: 1 }
  }, null, 2) + '\n');
}

async function post(route, body, headers = {}) {
  return fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function main() {
  writeFakeJob();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  try {
    await ready();

    // ---- 原有零回归断言（逐字保留） ----
    let response = await post('/api/literature/search', { query: 'test' });
    assert.equal(response.status, 403, 'browser write header is required');
    response = await post('/api/literature/search', { query: '' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400, 'missing config cannot start a job');
    response = await post('/api/literature/search', { config: { topic: 'test', query: 'test', sources: ['google-scholar', 'arxiv'] } }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400, 'unsupported source must not silently run Scholar only');
    response = await fetch(BASE + '/api/literature/job?id=bad');
    assert.equal(response.status, 400, 'invalid job id must be rejected');
    response = await fetch(BASE + '/api/literature/download?id=bad&name=../job.json');
    assert.equal(response.status, 400, 'download traversal must be rejected');

    // ---- 新增：search 的 until 边界校验（invalid until 在创建任务前被拒绝） ----
    response = await post('/api/literature/search', { config: { topic: 't', query: 'q', sources: ['google-scholar'] }, until: 'bogus' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400, 'invalid until must be rejected');
    assert.match((await response.json()).error, /阶段边界/);

    // 六来源各 2000 字的中文检索式应进入配置校验，不被原 16KiB 请求体上限截断；非法阶段确保不启动任何真实搜索。
    const sixSources = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'];
    response = await post('/api/literature/search', { config: { topic: '六来源请求体', query: 'q', sources: sixSources,
      sourceQueries: Object.fromEntries(sixSources.map(source => [source, '温'.repeat(2000)])) }, until: 'bogus' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /阶段边界/, '36KB 来源配置应通过请求体读取和配置检查');

    // 新模式先校验目标数量；使用非法阶段验证合法模式，不触发真实数据库访问。
    for (const target of [0, 1001, true]) {
      response = await post('/api/literature/search', { config: { topic: '正式检索', query: 'q', sources: ['pubmed'],
        searchMode: 'formal', perSourceLimit: target } }, { 'X-Workbench': '1' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /每来源检索数量/);
    }
    response = await post('/api/literature/search', { config: { topic: '正式检索', query: 'q', sources: ['pubmed'],
      searchMode: 'formal', perSourceLimit: 25 }, until: 'bogus' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /阶段边界/);
    response = await post('/api/literature/search', { config: { topic: '测试检索', query: 'q', sources: ['pubmed'],
      searchMode: 'test', perSourceLimit: 999, limit: 999 }, until: 'bogus' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /阶段边界/, '测试模式固定十条并忽略遗留正式数量');

    // ---- 新增：advance 路由 ----
    response = await post('/api/literature/advance', { id: FAKE_ID });
    assert.equal(response.status, 403, 'advance must require X-Workbench');
    response = await post('/api/literature/advance', { id: 'bad' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '无效检索任务标识');
    response = await post('/api/literature/advance', { id: '00000000-0000-0000-0000-000000000000' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '检索任务不存在');
    response = await post('/api/literature/advance', { id: FAKE_ID }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400, 'completed job without resumeStage must not advance');
    assert.equal((await response.json()).error, '该任务已完成全部阶段');

    // 登录浏览器入口沿用写请求防护，且不接受任意 URL 或非等待任务。
    response = await post('/api/literature/browser', { id: FAKE_ID });
    assert.equal(response.status, 403);
    response = await post('/api/literature/browser', { id: FAKE_ID }, { 'X-Workbench': '1', Origin: 'https://untrusted.test' });
    assert.equal(response.status, 403);
    response = await post('/api/literature/browser', { id: 'bad' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /无效检索任务标识/);
    response = await post('/api/literature/browser', { id: FAKE_ID, url: 'file:///private' }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /只需提供/);
    response = await post('/api/literature/browser', { id: FAKE_ID }, { 'X-Workbench': '1' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /没有等待/);

    // ---- 新增：jobs 列表 ----
    response = await fetch(BASE + '/api/literature/jobs?limit=50');
    assert.equal(response.status, 200);
    const jobs = (await response.json()).jobs;
    assert.ok(Array.isArray(jobs));
    assert.ok(jobs.some(job => job.id === FAKE_ID), 'fake job must appear in jobs list');
    response = await fetch(BASE + '/api/literature/jobs');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).jobs));

    // ---- 新增：download 登记校验与新 MIME ----
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=export/parameters.csv`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    const csvBytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV must keep utf-8-sig BOM');
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=export/literature.xlsx`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=validation/validation.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=job.json`);
    assert.equal(response.status, 400, 'job.json is not a registered deliverable');
    assert.equal((await response.json()).error, '结果文件不存在');
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=export/other.csv`);
    assert.equal(response.status, 400, 'unregistered name must be rejected even inside job dir');
    response = await fetch(`${BASE}/api/literature/download?id=${FAKE_ID}&name=../job.json`);
    assert.equal(response.status, 400);

    console.log('LITERATURE_HTTP_TESTS_PASS');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
