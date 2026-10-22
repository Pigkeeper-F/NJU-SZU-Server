'use strict';

// 文献挖掘·第二阶段 HTTP 持久回归（T2 固化，承接 V1 报告 P0）：
// 真实 server.js（含真实 extract 适配器注入 server.js → literature-extract.js）+ 桩 discover/fulltext
// + 真实 dedupe/extract/validate/export 脚本，走完整网页链：
// POST /search → POST /advance（awaiting_confirmation 关口）→ POST /advance{confirmations}
// → extract/validate/export 完成 → GET /jobs → GET /download（MIME/BOM/安全头/登记校验）。
// 此测试专门守住「server 真实注入 → advance → extract」这一曾经漏测的注入点：
// 若 server.js 的 runExtractStage 调用再次丢参（jobDir/config），本测试会在 awaiting_confirmation
// 断言处失败（真实行为：job failed『提取阶段缺少必要参数（bridge/jobDir/python）』）。
// 隔离口径：零网络、零浏览器；桩阶段脚本与 preload 生成在系统临时目录，结束后清理，仓库零残留；
// 桩只替换 discover/fulltext 两个需要网络/浏览器的阶段，其余阶段全部跑仓库真实脚本。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { __internals } = require('./literature-connector');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.LITERATURE_STAGE2_TEST_PORT || 8214);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findPython() {
  for (const candidate of [process.env.WORKBENCH_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import sys, openpyxl, pypdf; print(int(sys.version_info >= (3, 10)))'], { encoding: 'utf8' });
    if (!probe.error && String(probe.stdout || '').trim() === '1') return candidate;
  }
  return null;
}

// Windows 清理：run_config.json 为 0o444，先改可写；刚退出的 python 子进程句柄未释放时重试。
async function removeTree(dir) {
  const makeWritable = target => {
    let entries = [];
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) makeWritable(child);
      else { try { fs.chmodSync(child, 0o666); } catch (_) {} }
    }
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    makeWritable(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 39) throw error;
      await sleep(150);
    }
  }
}

const STUB_SEARCH = `import importlib, json, os, pathlib, sys

sys.path.insert(0, os.path.join(os.getcwd(), "tools"))
search = importlib.import_module("literature_search")

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

raw = {
    "url": "https://example.test/scholar?q=stage2-regression",
    "results": [
        {"title": "Fixture A: long-term fertilization effects on SOC",
         "byline": "Zhang Wei - Soil Biology and Biochemistry, 2019 - Elsevier",
         "snippet": "fixture snippet A", "result_url": "https://example.test/a1",
         "fulltext_links": [{"label": "[PDF]", "url": "https://example.test/a1.pdf"}],
         "doi": "10.1000/a1"},
        {"title": "Fixture B: SOC stocks under tillage practices",
         "byline": "Chen Hua - Geoderma, 2016 - Elsevier",
         "snippet": "fixture snippet B", "result_url": "https://example.test/b2",
         "fulltext_links": [], "doi": "10.1000/b2"},
    ],
}
out = search.write_results(job, "stage2 regression query", raw, None, batch_index=1)
emit({"type": "stage", "stage": "save", "message": "桩 discover：已保存候选（stage2 回归）"})
emit({"type": "result", "stage": "discover", "count": out["count"], "files": out["files"],
      "message": "已保存 %d 条候选（stub）" % out["count"]})
`;

const STUB_FULLTEXT = `import hashlib, json, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

def build_pdf():
    # 字节级合法、可被 pypdf 解析且 >=50KB 的最小 PDF（与 §3.5「%PDF + >=50KB」校验一致）。
    header = b"%PDF-1.4\\n"
    comment = b"%" + (b"stage2-http-regression-padding " * 2400) + b"\\n"
    stream = (b"BT /F1 12 Tf 72 720 Td (Soil organic carbon content was 12.4 g/kg "
              b"in the tillage experiment, 0-20 cm.) Tj ET\\n")
    objects = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\\n",
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >> endobj\\n",
        b"4 0 obj << /Length " + str(len(stream)).encode() + b" >> stream\\n" + stream + b"endstream endobj\\n",
        b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\\n",
    ]
    body = header + comment
    offsets = []
    for obj in objects:
        offsets.append(len(body))
        body += obj
    xref_pos = len(body)
    xref = b"xref\\n0 6\\n0000000000 65535 f \\n" + b"".join(
        ("%010d 00000 n \\n" % offset).encode() for offset in offsets
    )
    trailer = b"trailer << /Size 6 /Root 1 0 R >>\\nstartxref\\n" + str(xref_pos).encode() + b"\\n%%EOF\\n"
    return body + xref + trailer

files = job / "fulltext" / "files"
files.mkdir(parents=True, exist_ok=True)
(files / "GSC-001.pdf").write_bytes(build_pdf())
section_blocks = [
    ("Introduction", "长期施肥对土壤有机碳的影响是本研究关注的核心问题。" * 6),
    ("Materials and Methods", "试验设置免耕与翻耕两个处理，每个处理三次重复，取样深度为零至二十厘米。" * 6),
    ("Results", "免耕处理的土壤有机碳含量高于翻耕处理，差异具有统计学意义。" * 6),
    ("Conclusion", "长期免耕有助于提高表层土壤有机碳储量，仍需多年定位试验验证。" * 6),
]
text = "\\n".join(heading + "\\n" + body for heading, body in section_blocks)
(files / "GSC-002.txt").write_text(text, encoding="utf-8")
items = [
    {"paper_id": "GSC-001", "title": "Fixture A: long-term fertilization effects on SOC",
     "doi": "10.1000/a1", "source_url": "https://example.test/a1",
     "fulltext_url": "https://example.test/a1.pdf", "kind": "pdf", "status": "fetched_pdf",
     "path": "fulltext/files/GSC-001.pdf", "size": (files / "GSC-001.pdf").stat().st_size,
     "retrieved_at": "2026-10-15T00:00:00+00:00", "evidence_level": "fulltext_pdf", "reason": ""},
    {"paper_id": "GSC-002", "title": "Fixture B: SOC stocks under tillage practices",
     "doi": "10.1000/b2", "source_url": "https://example.test/b2",
     "fulltext_url": "https://example.test/b2", "kind": "html", "status": "fetched_html",
     "path": "fulltext/files/GSC-002.txt", "size": (files / "GSC-002.txt").stat().st_size,
     "retrieved_at": "2026-10-15T00:00:00+00:00", "evidence_level": "fulltext_html",
     "evidence_version": "fulltext-evidence-v1",
     "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
     "final_url": "https://example.test/b2",
     "html_evidence": {"origin": "dom_article_region", "container_verified": True,
                       "citation_title": "Fixture B: SOC stocks under tillage practices",
                       "citation_doi": "10.1000/b2",
                       "sections": [{"heading": heading, "text": body} for heading, body in section_blocks]},
     "reason": ""},
]
status = {
    "version": 1, "generated_at": "2026-10-15T00:00:00+00:00",
    "policy": "HTML 正文优先、PDF 备选；无法合法获取标为待补充，不绕过访问控制。",
    "items": items,
    "counts": {"total": 2, "fetched_pdf": 1, "fetched_html": 1, "abstract_only": 0,
               "unavailable": 0, "needs_attention": 0},
}
(job / "fulltext" / "status.json").write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
emit({"type": "stage", "stage": "fulltext", "message": "桩 fulltext：获取 2 篇全文（stage2 回归）"})
emit({"type": "result", "stage": "fulltext", "count": 2, "files": ["fulltext/status.json"],
      "counts": {"fetched": 2, "fetched_pdf": 1, "fetched_html": 1, "abstract_only": 0,
                 "unavailable": 0, "needs_attention": 0, "pending": 0, "skipped": 0},
      "message": "全文获取完成：已获取 2 篇（stub）"})
`;

function writePreload(work, python) {
  const source = `'use strict';
// 测试用 preload：把 .venv python 与 discover/fulltext 阶段脚本重映射到系统 python 与桩脚本（零网络）。
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const STUBS = ${JSON.stringify(path.join(work, 'stubs'))};
const PYTHON = ${JSON.stringify(python)};
const MAP = {
  'literature_search.py': path.join(STUBS, 'stub_search.py'),
  'literature_fulltext.py': path.join(STUBS, 'stub_fulltext.py')
};
const realSpawn = cp.spawn;
cp.spawn = function patchedSpawn(command, args, options) {
  try {
    let cmd = String(command);
    let argv = Array.isArray(args) ? [...args] : args;
    if (cmd.includes('.venv')) cmd = PYTHON;
    if (Array.isArray(argv) && argv.includes('venv')) {
      fs.mkdirSync(String(argv[argv.length - 1]), { recursive: true });
      return realSpawn(PYTHON, ['-c', 'pass'], options);
    }
    if (Array.isArray(argv) && argv.includes('pip') && argv.includes('install')) {
      return realSpawn(PYTHON, ['-c', 'pass'], options);
    }
    if (Array.isArray(argv) && argv.includes('playwright') && argv.includes('install')) {
      return realSpawn(PYTHON, ['-c', 'pass'], options);
    }
    if (Array.isArray(argv) && argv[0] === '-u' && typeof argv[1] === 'string') {
      const base = path.basename(argv[1]);
      if (MAP[base]) { argv[1] = MAP[base]; cmd = PYTHON; }
    }
    return realSpawn(cmd, argv, options);
  } catch (_) {
    return realSpawn(command, args, options);
  }
};
`;
  const file = path.join(work, 'preload.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function seedVenv() {
  const venv = path.join(ROOT, '.venv');
  if (fs.existsSync(venv)) return false;
  fs.mkdirSync(venv, { recursive: true });
  const hash = __internals.requirementsHash(ROOT);
  fs.writeFileSync(path.join(venv, '.literature-ready'),
    JSON.stringify({ schema: 2, requirementsSha256: hash, createdAt: new Date().toISOString(), python: 'stub' }) + '\n');
  return true;
}

const CONFIG = {
  topic: 'stage2 HTTP 持久回归（stub 主题）', query: 'stage2 regression query', sources: ['google-scholar'],
  publicationYearFrom: 2000, publicationYearTo: 2026, geography: '', language: '', studyTypes: [],
  inclusion: [], exclusion: [], targetFields: ['SOC'], limit: 10,
  batch: { size: 10, maxBatches: 1 },
  fieldDefinitions: [
    { key: 'soc', label: 'SOC', meaning: '土壤有机碳含量', unit: 'g/kg', valueType: 'number', required: true,
      allowedRange: { min: 0, max: 600 }, conditionKeys: ['site', 'treatment'] }
  ],
  templates: { literature: null, parameters: null },
  fulltext: { maxPapers: 0, perPaperTimeoutSec: 120 },
  extraction: { maxCharsPerPaper: 120000, model: null },
  limits: { discover: 180, dedupe: 120, fulltext: 600, extract: 600, validate: 300, export: 300 }
};

const EXTRACTION_RESULTS = {
  'GSC-001': {
    paper_id: 'GSC-001', source_pdf: 'fulltext/files/GSC-001.pdf', status: 'ok',
    classification_reason: 'stub：正文含报告值', rows: [{
      row_id: 'GSC-001-R001', field: 'soc', value_raw: '12.4', unit_raw: 'g/kg',
      value_normalized: 12.4, unit_normalized: 'g/kg', conversion: null,
      evidence: { where: 'p.1', quote: 'Soil organic carbon content was 12.4 g/kg.' },
      conditions: { site: 'S1', treatment: 'tillage' }, provenance: ''
    }], warnings: [], skip_reason: ''
  },
  'GSC-002': {
    paper_id: 'GSC-002', source_pdf: 'fulltext/files/GSC-002.txt', status: 'ok',
    classification_reason: 'stub：正文含报告值', rows: [{
      row_id: 'GSC-002-R001', field: 'soc', value_raw: '9.8', unit_raw: '',
      value_normalized: 9.8, unit_normalized: '', conversion: null,
      evidence: { where: 'html 第 1 段', quote: '翻耕处理 SOC 9.8。' },
      conditions: { site: 'S1', treatment: '翻耕' }, provenance: ''
    }], warnings: [], skip_reason: ''
  }
};

async function post(route, body, headers = {}) {
  return fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function waitTerminal(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  for (;;) {
    const response = await fetch(`${BASE}/api/literature/job?id=${id}`);
    job = await response.json().catch(() => null);
    if (job && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error('wait timeout, last status=' + (job && job.status));
    await sleep(300);
  }
}

async function main() {
  const python = findPython();
  if (!python) {
    console.log('LITERATURE_HTTP_STAGE2_TESTS_SKIP：未找到满足依赖（openpyxl/pypdf，Python≥3.10）的解释器');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-literature-http-stage2-'));
  fs.mkdirSync(path.join(work, 'stubs'), { recursive: true });
  fs.writeFileSync(path.join(work, 'stubs', 'stub_search.py'), STUB_SEARCH, 'utf8');
  fs.writeFileSync(path.join(work, 'stubs', 'stub_fulltext.py'), STUB_FULLTEXT, 'utf8');
  const preload = writePreload(work, python);
  const venvCreated = seedVenv();
  let jobId = null;
  let child = null;
  let done = 0;
  const step = (name, detail = '') => { done += 1; console.log(`ok ${done} - ${name}${detail ? '（' + detail + '）' : ''}`); };
  try {
    child = spawn(process.execPath, ['-r', preload, 'server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore'
    });
    let up = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(BASE + '/index.html')).status === 200) { up = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert.ok(up, 'test server did not start');
    step('隔离 server 就绪', `port ${PORT}`);

    const response = await post('/api/literature/search', { config: CONFIG }, { 'X-Workbench': '1' });
    const started = await response.json();
    jobId = started.id;
    assert.equal(response.status, 202, 'search must return 202');
    assert.match(String(jobId), /^[a-f0-9-]{36}$/);
    step('POST /search 202 + 36 位 id');

    const jobDir = path.join(ROOT, '.workbench', 'literature', jobId);
    const runConfigPath = path.join(jobDir, 'run_config.json');
    assert.equal(fs.statSync(runConfigPath).mode & 0o777, 0o444);
    let frozen = false;
    try { fs.appendFileSync(runConfigPath, 'x'); } catch (_) { frozen = true; }
    assert.ok(frozen, 'run_config.json 必须拒绝回写');
    step('run_config.json 0o444 冻结且拒绝回写');

    let snap = await waitTerminal(jobId);
    assert.equal(snap.status, 'completed');
    assert.equal(snap.stages.discover, 'done');
    assert.equal(snap.until, 'discover');
    assert.equal(snap.resumeStage, 'dedupe');
    assert.equal(snap.counters.candidates, 2);
    step('discover 完成（缺省 until=discover 不回归）', 'candidates=2');

    const advance = await post('/api/literature/advance', { id: jobId }, { 'X-Workbench': '1' });
    assert.equal(advance.status, 200);
    snap = await waitTerminal(jobId);
    assert.equal(snap.status, 'needs_attention', `expected fulltext_ready, got status=${snap.status} error=${snap.error} stage=${snap.stage} stages=${JSON.stringify(snap.stages)}`);
    assert.equal(snap.stage, 'fulltext_ready');
    assert.equal(snap.resumeStage, 'extract');
    assert.equal(snap.stages.extract, 'pending');
    assert.equal((await post('/api/literature/advance', { id: jobId }, { 'X-Workbench': '1' })).status, 200);
    snap = await waitTerminal(jobId);
    // P0 注入点护栏：server.js 真实注入的 extract 适配器必须能跑起来并停在字段确认关口；
    // 若 runExtractStage 再次丢 jobDir/config，这里会是 failed『提取阶段缺少必要参数…』。
    assert.equal(snap.status, 'needs_attention', `expected awaiting_confirmation gate, got status=${snap.status} error=${snap.error}`);
    assert.equal(snap.stage, 'awaiting_confirmation');
    assert.equal(snap.resumeStage, 'extract');
    step('advance → awaiting_confirmation 关口（真实 extract 适配器注入护栏）');

    assert.equal(snap.stages.discover, 'done');
    assert.equal(snap.stages.dedupe, 'done');
    assert.equal(snap.stages.fulltext, 'done');
    assert.equal(snap.stages.extract, 'running');
    assert.equal(snap.counters.uniqueGroups, 2);
    assert.equal(snap.counters.fulltextFetched, 2);
    assert.ok(snap.files.includes('fulltext/status.json') && snap.files.includes('fulltext/files/GSC-001.pdf'),
      'fulltext 交付物应已登记');
    step('stages 语义与全文交付物登记', 'extract 保持 running、fulltext/files 已入 files');

    const badConfirmations = await post('/api/literature/advance', { id: jobId, confirmations: { fields: [] } }, { 'X-Workbench': '1' });
    assert.equal(badConfirmations.status, 400);
    assert.equal((await badConfirmations.json()).error, '字段确认内容无效');
    step('非法 confirmations 400 文案');

    fs.mkdirSync(path.join(jobDir, 'extraction'), { recursive: true });
    for (const [paperId, payload] of Object.entries(EXTRACTION_RESULTS)) {
      fs.writeFileSync(path.join(jobDir, 'extraction', `${paperId}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }
    const confirmed = await post('/api/literature/advance', { id: jobId, confirmations: { fields: CONFIG.fieldDefinitions } }, { 'X-Workbench': '1' });
    assert.equal(confirmed.status, 200);
    snap = await waitTerminal(jobId);
    assert.equal(snap.error, null, `job failed: ${snap.error}`);
    assert.equal(snap.status, 'completed');
    assert.equal(snap.resumeStage, null);
    assert.ok(Object.values(snap.stages).every(value => value === 'done'), JSON.stringify(snap.stages));
    step('确认后续跑至 completed（extract→validate→export 真实脚本）');

    const confirmations = JSON.parse(fs.readFileSync(path.join(jobDir, 'confirmations.json'), 'utf8'));
    assert.equal(confirmations.records.length, 1);
    assert.equal(confirmations.records[0].by, 'researcher');
    assert.equal(confirmations.records[0].kind, 'fieldDefinitions');
    assert.equal(confirmations.records[0].fields[0].key, 'soc');
    step('confirmations.json append-only 追加');

    assert.ok(fs.existsSync(path.join(jobDir, 'extraction', 'check_report.json')), '真实 --check 应落盘 check_report.json');
    assert.equal(snap.counters.extractedPapers, 2);
    assert.equal(snap.counters.parameterRows, 2);
    step('真实 --check 落盘与 counters', 'extractedPapers=2 parameterRows=2');

    const eventLines = fs.readFileSync(path.join(jobDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(eventLines.length >= 10 && eventLines.every(entry => ['stage', 'attention', 'error', 'result'].includes(entry.type)));
    step('events.jsonl 全量审计行合法', `${eventLines.length} 行`);

    const jobsResponse = await fetch(`${BASE}/api/literature/jobs?limit=50`);
    const jobs = await jobsResponse.json();
    assert.equal(jobsResponse.status, 200);
    assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.some(job => job.id === jobId));
    step('GET /jobs 含该任务');

    const download = async name => {
      const resp = await fetch(`${BASE}/api/literature/download?id=${jobId}&name=${encodeURIComponent(name)}`);
      return { resp, buf: Buffer.from(await resp.arrayBuffer()) };
    };
    let item = await download('export/parameters.csv');
    assert.equal(item.resp.status, 200);
    assert.equal(item.resp.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.deepEqual([...item.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(item.resp.headers.get('cache-control'), 'no-store');
    assert.equal(item.resp.headers.get('x-content-type-options'), 'nosniff');
    assert.match(String(item.resp.headers.get('content-disposition')), /filename\*=UTF-8''/);
    step('download parameters.csv：MIME + BOM + 安全头');

    item = await download('export/literature.xlsx');
    assert.equal(item.resp.status, 200);
    assert.equal(item.resp.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    step('download literature.xlsx MIME');

    item = await download('fulltext/files/GSC-001.pdf');
    assert.equal(item.resp.status, 200);
    assert.equal(item.resp.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...item.buf.subarray(0, 4)], [...Buffer.from('%PDF')]);
    assert.ok(item.buf.length >= 50000);
    step('download 全文 PDF：octet-stream + %PDF + ≥50KB');

    item = await download('job.json');
    let body = null;
    try { body = JSON.parse(item.buf.toString('utf8')); } catch (_) {}
    assert.equal(item.resp.status, 400);
    assert.ok(body && body.error === '结果文件不存在');
    step('download 未登记名 400');

    item = await download('../run_config.json');
    assert.equal(item.resp.status, 400);
    step('download 穿越名 400');

    console.log('LITERATURE_HTTP_STAGE2_TESTS_PASS');
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await sleep(500);
      try { child.kill('SIGKILL'); } catch (_) {}
    }
    if (jobId) {
      try { await removeTree(path.join(ROOT, '.workbench', 'literature', jobId)); } catch (error) { console.error('job cleanup: ' + error.message); }
    }
    try { await removeTree(work); } catch (error) { console.error('temp cleanup: ' + error.message); }
    if (venvCreated) {
      try { await removeTree(path.join(ROOT, '.venv')); } catch (error) { console.error('venv cleanup: ' + error.message); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
