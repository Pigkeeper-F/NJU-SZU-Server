'use strict';

// 文献连接器测试（第二阶段扩展）：
// S0 原 mock 单阶段回归；S1 桩阶段脚本六阶段 advance→download 冒烟；S2 PYTHONUTF8 注入回归；
// S3 interrupted 重建 + 续跑；S4 cancel 双文案；S5 advance/snapshot 守卫边界；S6 marker v2 依赖感知；S7 jobs 列表。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LiteratureConnector, STAGES, __internals } = require('./literature-connector');
const { normalizeConfig } = require('./literature-config');

const config = { topic: '气候变化与养殖', query: 'climate change aquaculture China', sources: ['google-scholar'], publicationYearFrom: 2000, publicationYearTo: 2026,
  geography: '中国', language: '', studyTypes: ['原始研究'], inclusion: [], exclusion: [], targetFields: ['产量'], limit: 10 };

function findPython() {
  for (const candidate of [process.env.WORKBENCH_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3, 10)))'], { encoding: 'utf8' });
    if (!probe.error && String(probe.stdout || '').trim() === '1') return candidate;
  }
  return null;
}

async function waitDone(connector, id, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const job = connector.snapshot(id);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('mock connector did not finish');
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
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

const STUB_SEARCH = `import json, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
job.mkdir(parents=True, exist_ok=True)
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

candidates = {
    "version": 2, "source": "Google Scholar", "query": "stub", "count": 1,
    "scope": "first_page_candidates_only", "caution": "stub",
    "batches": [{"batch_index": 1, "status": "complete"}],
    "records": [{"candidate_id": "GSC-001", "title": "中文标题（stub）",
                 "screening_status": "pending_review", "evidence_level": "search_result_snippet"}],
}
(job / "candidates.json").write_text(json.dumps(candidates, ensure_ascii=False), encoding="utf-8")
(job / "candidates.csv").write_text("candidate_id\\nGSC-001\\n", encoding="utf-8-sig")
emit({"type": "stage", "stage": "search", "message": "中文阶段消息：检索连接成功"})
emit({"type": "result", "stage": "completed", "count": 1, "files": ["candidates.json", "candidates.csv"], "message": "已保存 1 条候选（中文）"})
`;

const STUB_DEDUPE = `import json, os, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

if os.environ.get("LIT_STUB_FAIL") == "dedupe":
    emit({"type": "error", "message": "去重失败：stub 故障（中文）"})
    raise SystemExit(1)

(job / "dedupe").mkdir(parents=True, exist_ok=True)
counts = {"records_in": 1, "groups": 1, "merged": 0, "needs_review_groups": 0}
payload = {"version": 1, "threshold": 0.55, "counts": counts,
           "groups": [{"canonical_id": "GSC-001", "title": "中文标题（stub）", "records": []}]}
(job / "dedupe" / "dedupe.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
(job / "dedupe" / "dedupe.csv").write_text("canonical_id\\nGSC-001\\n", encoding="utf-8-sig")
emit({"type": "stage", "stage": "dedupe", "message": "对累计候选执行跨来源归并去重（stub）"})
emit({"type": "result", "stage": "dedupe", "count": 1, "counts": counts,
      "files": ["dedupe/dedupe.json", "dedupe/dedupe.csv"], "message": "去重完成：1 组（中文）"})
`;

const STUB_FULLTEXT = `import json, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

(job / "fulltext" / "files").mkdir(parents=True, exist_ok=True)
(job / "fulltext" / "files" / "GSC-001.txt").write_text("中文全文正文" * 20, encoding="utf-8")
items = [{"paper_id": "GSC-001", "title": "中文标题（stub）", "doi": "", "source_url": "https://example.test/x",
          "fulltext_url": "", "kind": "html", "status": "fetched_html", "path": "fulltext/files/GSC-001.txt",
          "size": 6, "retrieved_at": "", "evidence_level": "fulltext_html", "reason": ""}]
status = {"version": 1, "policy": "stub 策略", "items": items,
          "counts": {"total": 1, "fetched_pdf": 0, "fetched_html": 1, "abstract_only": 0, "unavailable": 0, "needs_attention": 0}}
(job / "fulltext" / "status.json").write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
emit({"type": "stage", "stage": "fulltext", "message": "开始全文获取（stub，中文）"})
emit({"type": "result", "stage": "fulltext", "count": 1,
      "counts": {"fetched": 1, "fetched_pdf": 0, "fetched_html": 1, "unavailable": 0},
      "files": ["fulltext/status.json"], "message": "全文获取完成：已获取 1 篇（中文）"})
`;

const STUB_EXTRACT = `import json, os, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

emit({"type": "stage", "stage": "extraction", "message": "stub 提取阶段"})
if "--prepare" in args:
    (job / "extraction" / "inputs").mkdir(parents=True, exist_ok=True)
    bundle = {"schema_version": 1, "instructions_version": "extract-contract-v1", "schema_sha256": "stub",
              "paper_id": "GSC-001", "title": "中文标题（stub）", "doi": "", "source_url": "",
              "fulltext": {"kind": "html", "path": "fulltext/files/GSC-001.txt", "text": "中文正文", "chars": 4, "truncated": False},
              "field_definitions": [{"key": "soc", "label": "SOC", "meaning": "stub", "unit": "g/kg", "valueType": "number", "required": True}],
              "condition_keys": []}
    (job / "extraction" / "inputs" / "GSC-001.json").write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    result = {"paper_id": "GSC-001", "source_pdf": "GSC-001.txt", "status": "ok", "classification_reason": "stub",
              "rows": [{"row_id": "GSC-001-R001", "field": "soc", "value_raw": "12", "unit_raw": "g/kg", "value_normalized": 12,
                        "unit_normalized": "g/kg", "conversion": None, "evidence": {"where": "p.1", "quote": "stub"},
                        "conditions": {}, "provenance": ""}],
              "warnings": [], "skip_reason": ""}
    (job / "extraction" / "GSC-001.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    emit({"type": "result", "stage": "extraction", "count": 1, "counts": {"bundles": 1, "extracted": 1, "skipped": 0},
          "files": ["extraction/inputs/GSC-001.json", "extraction/GSC-001.json"], "message": "提取输入包已生成（1 篇，stub）"})
elif "--check" in args:
    if os.environ.get("LIT_STUB_FAIL") == "extract-check":
        emit({"type": "error", "message": "提取结果校验未通过（stub）"})
        raise SystemExit(1)
    (job / "extraction" / "check_report.json").write_text(json.dumps({"failed": 0, "ok": 1}, ensure_ascii=False), encoding="utf-8")
    emit({"type": "result", "stage": "extraction", "count": 1, "counts": {"ok": 1, "failed": 0},
          "files": ["extraction/GSC-001.json", "extraction/check_report.json"], "message": "提取结果全部通过（1 篇，stub）"})
else:
    emit({"type": "error", "message": "stub 提取脚本缺少 --prepare/--check"})
    raise SystemExit(2)
`;

const STUB_VALIDATE = `import json, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

(job / "validation").mkdir(parents=True, exist_ok=True)
payload = {"version": 1, "counts": {"parameters_total": 1, "ok": 1, "blocking": 0, "pending": 0}, "blocking": [], "pending": []}
(job / "validation" / "validation.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
(job / "validation" / "validation.md").write_text("# 待审清单（stub）\\n", encoding="utf-8")
emit({"type": "stage", "stage": "validation", "message": "按已确认字段定义校验提取结果（stub）"})
emit({"type": "result", "stage": "validation", "count": 1, "counts": {"blocking": 0, "pending": 0, "ok": 1},
      "files": ["validation/validation.json", "validation/validation.md"], "message": "校验通过：1 个参数行（中文）"})
`;

const STUB_EXPORT = `import json, pathlib, sys

args = sys.argv[1:]
def value(name):
    return args[args.index(name) + 1] if name in args else None

job = pathlib.Path(value("--output-dir"))
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

(job / "export").mkdir(parents=True, exist_ok=True)
(job / "export" / "literature.csv").write_text("paper_id\\nGSC-001\\n", encoding="utf-8-sig")
(job / "export" / "literature.xlsx").write_bytes(b"PK\\x03\\x04stub")
(job / "export" / "parameters.csv").write_text("row_id\\nGSC-001-R001\\n", encoding="utf-8-sig")
(job / "export" / "parameters.xlsx").write_bytes(b"PK\\x03\\x04stub")
(job / "export" / "export_report.md").write_text("# 导出报告（stub）\\n", encoding="utf-8")
emit({"type": "stage", "stage": "export", "message": "按已确认字段定义导出（stub）"})
emit({"type": "result", "stage": "export", "count": 1, "counts": {"literature": 1},
      "files": ["export/literature.csv", "export/literature.xlsx", "export/parameters.csv", "export/parameters.xlsx", "export/export_report.md"],
      "message": "已导出 1 篇文献、1 个参数行（中文）"})
`;

function writeStubScripts(root) {
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'literature_search.py'), STUB_SEARCH);
  fs.writeFileSync(path.join(tools, 'literature_dedupe.py'), STUB_DEDUPE);
  fs.writeFileSync(path.join(tools, 'literature_fulltext.py'), STUB_FULLTEXT);
  fs.writeFileSync(path.join(tools, 'literature_extract.py'), STUB_EXTRACT);
  fs.writeFileSync(path.join(tools, 'literature_validate.py'), STUB_VALIDATE);
  fs.writeFileSync(path.join(tools, 'literature_export.py'), STUB_EXPORT);
}

function stubConnector(root, python) {
  return new LiteratureConnector(root, {
    prepare: async (_job, progress) => { progress('environment', 'mock ready'); return python; }
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-literature-test-'));
  try {
    // ---------- S0：原 mock 单阶段回归（不依赖本机 python） ----------
    const connector = new LiteratureConnector(root, {
      prepare: async (_job, progress) => { progress('environment', 'mock ready'); return 'mock-python'; },
      search: async (job, _python, onEvent) => {
        onEvent({ type: 'stage', stage: 'search', message: 'mock search' });
        fs.writeFileSync(path.join(job.dir, 'candidates.json'), '{"records":[]}');
        fs.writeFileSync(path.join(job.dir, 'candidates.csv'), 'title\n');
        onEvent({ type: 'result', count: 0, files: ['candidates.json', 'candidates.csv'], message: 'mock complete' });
      }
    });
    assert.throws(() => connector.start({ ...config, topic: '' }), /研究主题/);
    assert.throws(() => connector.start({ ...config, limit: 11 }), /1–10/);
    assert.throws(() => connector.start({ ...config, sources: ['google-scholar', 'scopus'] }), /尚未接通/);
    assert.throws(() => normalizeConfig({ ...config, publicationYearFrom: 2026, publicationYearTo: 2000 }), /不能晚于/);
    const started = connector.start(config);
    const done = await waitDone(connector, started.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.config.query, config.query);
    assert.equal(done.until, 'discover');
    assert.deepEqual(done.files, ['run_config.json', 'candidates.json', 'candidates.csv']);
    assert.equal(done.stages.discover, 'done');
    assert.equal(done.resumeStage, 'dedupe');
    assert.deepEqual(JSON.parse(fs.readFileSync(connector.download(done.id, 'run_config.json'), 'utf8')).publicationYearFrom, 2000);
    assert.equal(fs.readFileSync(connector.download(done.id, 'candidates.csv'), 'utf8'), 'title\n');
    assert.throws(() => connector.download(done.id, '../job.json'), /不存在/);
    const reloaded = new LiteratureConnector(root);
    assert.equal(reloaded.snapshot(done.id).status, 'completed');
    assert.ok(done.events.some(event => event.stage === 'search'));
    assert.ok(fs.readFileSync(path.join(root, '.workbench', 'literature', done.id, 'events.jsonl'), 'utf8').includes('mock search'));

    // ---------- 桩阶段脚本场景（S1/S2/S3/S4/S7 共用同一工作区） ----------
    const python = findPython();
    if (!python) {
      console.log('LITERATURE_CONNECTOR_TESTS_PARTIAL（本机无 Python 3.10+，桩脚本场景跳过）');
      console.log('LITERATURE_CONNECTOR_TESTS_PASS');
      return;
    }
    writeStubScripts(root);
    const stub = stubConnector(root, python);

    // ---------- S1：start(discover) → 失败重试 → 关口暂停 → confirmations → export ----------
    const jobA = await waitDone(stub, stub.start(config).id);
    assert.equal(jobA.status, 'completed');
    assert.equal(jobA.resumeStage, 'dedupe');
    assert.deepEqual(jobA.files, ['run_config.json', 'candidates.json', 'candidates.csv']);

    process.env.LIT_STUB_FAIL = 'dedupe';
    let advanced = stub.advance(jobA.id);
    assert.equal(advanced.status, 'running');
    assert.equal(advanced.until, 'export');
    const failed = await waitDone(stub, jobA.id);
    delete process.env.LIT_STUB_FAIL;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /去重失败：stub 故障（中文）/);
    assert.equal(failed.resumeStage, 'dedupe');
    assert.equal(failed.stages.dedupe, 'failed');

    advanced = stub.advance(jobA.id);
    const paused = await waitDone(stub, jobA.id);
    assert.equal(paused.status, 'needs_attention');
    assert.equal(paused.stage, 'awaiting_confirmation');
    assert.equal(paused.resumeStage, 'extract');
    assert.equal(paused.stages.dedupe, 'done');
    assert.equal(paused.stages.fulltext, 'done');
    assert.ok(paused.files.includes('dedupe/dedupe.json'));
    assert.ok(paused.files.includes('fulltext/status.json'));
    assert.ok(paused.files.includes('fulltext/files/GSC-001.txt'));
    assert.equal(fs.existsSync(path.join(root, '.workbench', 'literature', jobA.id, 'confirmations.json')), false);
    assert.throws(() => stub.advance(jobA.id, { confirmations: { fields: [] } }), /字段确认内容无效/);

    advanced = stub.advance(jobA.id, { confirmations: { fields: [{ key: 'soc', label: 'SOC', meaning: '土壤有机碳', unit: 'g/kg', valueType: 'number', required: true }] } });
    assert.equal(advanced.status, 'running');
    const finished = await waitDone(stub, jobA.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.resumeStage, null);
    assert.equal(finished.stages.extract, 'done');
    assert.equal(finished.stages.validate, 'done');
    assert.equal(finished.stages.export, 'done');
    const confirmations = JSON.parse(fs.readFileSync(path.join(root, '.workbench', 'literature', jobA.id, 'confirmations.json'), 'utf8'));
    assert.equal(confirmations.records.length, 1);
    assert.equal(confirmations.records[0].kind, 'fieldDefinitions');
    assert.deepEqual(finished.files, ['run_config.json', 'candidates.json', 'candidates.csv', 'dedupe/dedupe.json', 'dedupe/dedupe.csv',
      'fulltext/status.json', 'fulltext/files/GSC-001.txt', 'extraction/inputs/GSC-001.json', 'extraction/GSC-001.json',
      'extraction/check_report.json', 'validation/validation.json', 'validation/validation.md',
      'export/literature.csv', 'export/literature.xlsx', 'export/parameters.csv', 'export/parameters.xlsx', 'export/export_report.md']);
    assert.ok(fs.existsSync(stub.download(jobA.id, 'export/parameters.xlsx')));
    assert.ok(fs.existsSync(stub.download(jobA.id, 'extraction/check_report.json')));
    assert.throws(() => stub.download(jobA.id, 'export/history/x.csv'), /不存在/);
    assert.equal(finished.counters.candidates, 1);
    assert.equal(finished.counters.uniqueGroups, 1);
    assert.equal(finished.counters.fulltextFetched, 1);
    assert.equal(finished.counters.extractedPapers, 1);
    assert.equal(finished.counters.parameterRows, 1);
    assert.throws(() => stub.advance(jobA.id), /该任务已完成全部阶段/);

    // ---------- S2：剥离父进程 UTF8 变量 → spawn 仍注入 → 中文无 U+FFFD ----------
    const savedUtf8 = process.env.PYTHONUTF8;
    const savedIoEncoding = process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
    delete process.env.PYTHONIOENCODING;
    try {
      const utf8Job = await waitDone(stub, stub.start(config).id);
      assert.equal(utf8Job.status, 'completed');
      assert.ok(utf8Job.events.some(event => event.message && event.message.includes('检索连接成功')), '中文事件消息必须完整（无 U+FFFD）');
      assert.ok(!JSON.stringify(utf8Job.events).includes('\uFFFD'), '事件流不得出现 U+FFFD');
      const log = fs.readFileSync(path.join(root, '.workbench', 'literature', utf8Job.id, 'events.jsonl'), 'utf8');
      assert.ok(log.includes('已保存 1 条候选（中文）'));
      assert.ok(!log.includes('\uFFFD'));
    } finally {
      if (savedUtf8 !== undefined) process.env.PYTHONUTF8 = savedUtf8;
      if (savedIoEncoding !== undefined) process.env.PYTHONIOENCODING = savedIoEncoding;
    }

    // ---------- S3：interrupted（服务重启遗留 running）重建 + advance 续跑 ----------
    const interruptedId = 'abcdef00-1234-5678-9abc-def012345678';
    const interruptedDir = path.join(root, '.workbench', 'literature', interruptedId);
    fs.mkdirSync(path.join(interruptedDir, 'dedupe'), { recursive: true });
    fs.mkdirSync(path.join(interruptedDir, 'fulltext'), { recursive: true });
    fs.writeFileSync(path.join(interruptedDir, 'run_config.json'), JSON.stringify(normalizeConfig(config), null, 2) + '\n');
    fs.writeFileSync(path.join(interruptedDir, 'candidates.json'), JSON.stringify({ version: 2, batches: [{ batch_index: 1 }], records: [{ candidate_id: 'GSC-001' }] }));
    fs.writeFileSync(path.join(interruptedDir, 'candidates.csv'), 'candidate_id\nGSC-001\n');
    fs.writeFileSync(path.join(interruptedDir, 'dedupe', 'dedupe.json'), JSON.stringify({ version: 1, groups: [] }));
    fs.writeFileSync(path.join(interruptedDir, 'fulltext', 'status.json'), JSON.stringify({ version: 1, items: [{ paper_id: 'GSC-001', status: 'pending' }] }));
    fs.writeFileSync(path.join(interruptedDir, 'job.json'), JSON.stringify({ id: interruptedId, status: 'running', stage: 'fulltext',
      message: '全文获取中', count: 1, config: normalizeConfig(config), files: ['run_config.json'], events: [], error: null }, null, 2) + '\n');
    const fresh = new LiteratureConnector(root, { prepare: async (_job, progress) => { progress('environment', 'mock ready'); return python; } });
    const interrupted = fresh.snapshot(interruptedId);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.stage, 'interrupted');
    assert.equal(interrupted.error, '本地服务已重启，检索中断；已保存的文件仍可下载。');
    assert.equal(interrupted.resumeStage, 'fulltext');
    assert.deepEqual(interrupted.stages, { discover: 'done', dedupe: 'done', fulltext: 'pending', extract: 'pending', validate: 'pending', export: 'pending' });
    assert.ok(interrupted.files.includes('candidates.json'));
    assert.ok(interrupted.files.includes('dedupe/dedupe.json'));
    fresh.advance(interruptedId, { until: 'fulltext' });
    const resumed = await waitDone(fresh, interruptedId);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.stages.fulltext, 'done');
    assert.equal(resumed.resumeStage, 'extract');

    // ---------- S4：cancel 双文案 ----------
    const cancelDiscover = stub.start(config);
    const cancelledA = stub.cancel(cancelDiscover.id);
    assert.equal(cancelledA.status, 'cancelled');
    assert.equal(cancelledA.message, '检索已停止；持久浏览器保持打开');
    const cancelLater = await waitDone(stub, stub.start(config).id);
    stub.advance(cancelLater.id);
    const cancelledB = stub.cancel(cancelLater.id);
    assert.equal(cancelledB.status, 'cancelled');
    assert.equal(cancelledB.message, '任务已停止；已完成的阶段产物保留');
    assert.throws(() => stub.advance(cancelLater.id), /任务已停止，不能继续；请发起新检索/);
    await new Promise(resolve => setTimeout(resolve, 100));

    // ---------- S5：守卫边界 ----------
    assert.throws(() => stub.advance('bad'), /无效检索任务标识/);
    assert.throws(() => stub.advance('00000000-0000-0000-0000-000000000000'), /检索任务不存在/);
    assert.throws(() => stub.start(config, false, 'bogus'), /阶段边界必须是 discover–export 的有效阶段名/);
    assert.throws(() => stub.advance(jobA.id, { until: 'bogus' }), /阶段边界必须是 discover–export 的有效阶段名/);
    assert.throws(() => stub.snapshot('bad'), /无效检索任务标识/);
    assert.throws(() => stub.snapshot('00000000-0000-0000-0000-000000000000'), /检索任务不存在/);

    // ---------- S7：jobs 列表（mtime 倒序、limit 收敛、损坏记录跳过） ----------
    const listed = stub.list(50);
    assert.ok(listed.some(job => job.id === jobA.id));
    assert.ok(listed.some(job => job.id === interruptedId));
    assert.equal(stub.list(1).length, 1);
    assert.ok(Array.isArray(stub.list(999)));
    assert.ok(Array.isArray(stub.list('abc')));
    const brokenId = '11111111-2222-3333-4444-555555555555';
    fs.mkdirSync(path.join(root, '.workbench', 'literature', brokenId), { recursive: true });
    fs.writeFileSync(path.join(root, '.workbench', 'literature', brokenId, 'job.json'), '{broken');
    assert.ok(!stub.list(50).some(job => job.id === brokenId));
    assert.throws(() => stub.snapshot(brokenId), /检索任务不存在/);

    // ---------- S6：marker v2（依赖变更感知） ----------
    const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-literature-marker-'));
    try {
      fs.writeFileSync(path.join(markerRoot, 'requirements-literature.txt'), 'playwright>=1.40,<2\r\nopenpyxl>=3.1,<4\n');
      const hash = __internals.requirementsHash(markerRoot);
      fs.writeFileSync(path.join(markerRoot, 'requirements-literature.txt'), 'playwright>=1.40,<2\nopenpyxl>=3.1,<4\n');
      assert.equal(__internals.requirementsHash(markerRoot), hash, 'CRLF/LF 归一后哈希一致');
      const venvPython = path.join(markerRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      fs.mkdirSync(path.dirname(venvPython), { recursive: true });
      fs.writeFileSync(venvPython, '');
      const markerFile = path.join(markerRoot, '.venv', '.literature-ready');
      fs.writeFileSync(markerFile, JSON.stringify({ schema: 2, requirementsSha256: hash, createdAt: new Date().toISOString(), python: '3.13.7' }));
      assert.equal(await __internals.preparePython(markerRoot, {}, () => {}), venvPython);
      fs.writeFileSync(markerFile, JSON.stringify({ schema: 2, requirementsSha256: 'deadbeef' }));
      await assert.rejects(__internals.preparePython(markerRoot, {}, () => {}), /./, 'sha 不一致必须触发重装');
      fs.writeFileSync(markerFile, '2026-01-01T00:00:00.000Z\n');
      await assert.rejects(__internals.preparePython(markerRoot, {}, () => {}), /./, '旧纯文本 marker 视为过期');
    } finally {
      await removeTree(markerRoot);
    }

    console.log('LITERATURE_CONNECTOR_TESTS_PASS');
  } finally {
    delete process.env.LIT_STUB_FAIL;
    await removeTree(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
