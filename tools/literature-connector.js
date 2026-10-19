'use strict';

// 文献挖掘连接器（第二阶段：六阶段 steps 编排 + advance 续跑 + 交付物登记）。
// 契约：docs/literature-mining-stage2-design.md §1.2/§3/§4/§8/§9.6、docs/contract.md §21。
// 向后兼容：start() 缺省 until=discover 时与第一阶段行为逐字一致（不回归清单见设计 §10）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { normalizeConfig } = require('./literature-config');
const { executableSources } = require('./literature-sources');
const { proxyFor } = require('./source-download');

function childEnv() {
  const proxy = proxyFor('https:');
  return { ...process.env, PYTHONIOENCODING: 'utf-8', ...(proxy ? { HTTPS_PROXY: proxy.href, HTTP_PROXY: proxy.href } : {}) };
}

const ID = /^[a-f0-9-]{36}$/;

//: 六阶段冻结顺序（设计 §2；与 tools/literature-common.py STAGES 一致）
const STAGES = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];

//: 阶段 → 脚本文件名（§2.4 冻结 CLI）
const STAGE_SCRIPTS = {
  discover: 'literature_search.py',
  dedupe: 'literature_dedupe.py',
  fulltext: 'literature_fulltext.py',
  extract: 'literature_extract.py',
  validate: 'literature_validate.py',
  export: 'literature_export.py'
};

//: 各阶段默认超时（秒；discover 每来源 180 秒，单来源保持既有文案）。
const STAGE_TIMEOUTS = { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800, validate: 300, export: 600 };

const STAGE_LABELS = { discover: '候选检索', dedupe: '跨来源去重', fulltext: '全文获取', extract: '参数提取', validate: '校验', export: '导出' };

//: 交付物静态模式表（§9.6/§21.2.5）：result.files 命中模式且文件存在才登记进 job.files。
//: extraction/<id>.json 覆盖逐篇结果与 check_report.json（§4.1 目录树）。
const DELIVERABLE_PATTERNS = [
  /^run_config\.json$/,
  /^candidates\.(?:json|csv)$/,
  /^dedupe\/dedupe\.(?:json|csv)$/,
  /^fulltext\/status\.json$/,
  /^fulltext\/files\/[^/\\]+\.(?:pdf|txt)$/,
  /^extraction\/inputs\/[^/\\]+\.json$/,
  /^extraction\/[^/\\]+\.json$/,
  /^validation\/validation\.(?:json|md)$/,
  /^export\/[^/\\]+\.(?:csv|xlsx|md)$/
];

function isDeliverable(name) {
  return typeof name === 'string' && DELIVERABLE_PATTERNS.some(pattern => pattern.test(name));
}

//: 全部 Python spawn 显式注入编码变量（§8.2 双防线之一）。
function pythonEnv() {
  return { ...childEnv(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function resolveLimits(config) {
  const limits = { ...STAGE_TIMEOUTS };
  const sourceCount = Array.isArray(config?.sources) ? config.sources.length : 1;
  limits.discover *= Math.min(6, Math.max(1, sourceCount));
  if (config && typeof config === 'object' && config.limits && typeof config.limits === 'object') {
    for (const stage of STAGES) {
      const value = config.limits[stage];
      if (Number.isInteger(value) && value > 0) limits[stage] = value;
    }
  }
  return limits;
}

function timeoutText(stage, seconds) {
  if (stage === 'discover' && seconds === 180) return '检索超过 3 分钟，已停止；如遇验证请手动完成后重试。';
  return `阶段执行超过 ${seconds} 秒，已停止；已完成的产物保留。`;
}

function loadJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sourceAttention(value) {
  if (!value || typeof value !== 'object') return null;
  if (!executableSources().some(source => source.key === value.source)) return null;
  if (!['login', 'verification', 'access_required', 'results_unrecognized'].includes(value.reason)) return null;
  return { source: value.source, reason: value.reason };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.job?.status === 'cancelled') { reject(new Error('检索已停止')); return; }
    const child = spawn(command, args, { cwd: options.cwd, env: pythonEnv(), windowsHide: true });
    if (options.job) options.job.child = child;
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error('准备检索环境超时'));
    }, options.timeout || 180000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.job?.child === child) options.job.child = null;
      if (error) reject(error); else resolve(output.trim());
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-3000); });
    }
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(output.trim() || `命令退出码 ${code}`)));
  });
}

async function findPython(root) {
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const candidates = [process.env.WORKBENCH_PYTHON, ...(fs.existsSync(bundled) ? [bundled] : []), 'python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await runCommand(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3, 10)))'], { cwd: root, timeout: 5000 });
      if (result === '1') return candidate;
    } catch (_) { /* Try the next installed interpreter. */ }
  }
  throw new Error('未找到 Python 3.10+。请安装后重试，或设置 WORKBENCH_PYTHON 指向可用解释器。');
}

//: requirements-literature.txt 内容 sha256（LF 归一，§8.1）。
function requirementsHash(root) {
  const file = path.join(root, 'requirements-literature.txt');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

//: 读取 marker；仅接受 v2 JSON 结构，旧纯文本 marker 一律视为过期（§8.1）。
function readReadyMarker(marker) {
  const data = loadJsonFile(marker);
  if (data && typeof data === 'object' && data.schema === 2 && typeof data.requirementsSha256 === 'string') return data;
  return null;
}

async function preparePython(root, job, progress) {
  const venv = path.join(root, '.venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const marker = path.join(venv, '.literature-ready');
  const hash = requirementsHash(root);
  const ready = fs.existsSync(marker) ? readReadyMarker(marker) : null;
  if (fs.existsSync(python) && ready && ready.requirementsSha256 === hash) return python;
  progress('environment', '准备 Python 虚拟环境与 Chromium（首次运行可能较久）');
  if (!fs.existsSync(python)) {
    const base = await findPython(root);
    await runCommand(base, ['-m', 'venv', venv], { cwd: root, timeout: 120000, job });
  }
  // 依赖变更感知：requirements 变了（或 marker 缺省/旧格式）→ 重装；pip/playwright 超时 600s（裁决 D6）。
  await runCommand(python, ['-m', 'pip', 'install', '-r', path.join(root, 'requirements-literature.txt')], { cwd: root, timeout: 600000, job });
  await runCommand(python, ['-m', 'playwright', 'install', 'chromium'], { cwd: root, timeout: 600000, job });
  let version = '';
  try {
    version = await runCommand(python, ['-c', 'import sys; print(sys.version.split()[0])'], { cwd: root, timeout: 15000, job });
  } catch (_) { /* 版本串仅作记录，拿不到不阻断 */ }
  fs.writeFileSync(marker, JSON.stringify({ schema: 2, requirementsSha256: hash, createdAt: new Date().toISOString(), python: version }) + '\n');
  return python;
}

//: 通用阶段执行器（§9.6）：spawn python -u <script> --config/--output-dir + stdout NDJSON。
//: discover 沿用既有 180s 文案；其余阶段用新超时文案（§8.3）。
function runStageProcess(root, job, python, scriptName, extraArgs, onEvent) {
  return new Promise((resolve, reject) => {
    const stage = job.activeStage || 'discover';
    const seconds = job.limits?.[stage] || STAGE_TIMEOUTS[stage] || 180;
    const script = path.join(root, 'tools', scriptName);
    const args = ['-u', script, '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir, ...(extraArgs || [])];
    const child = spawn(python, args, { cwd: root, env: pythonEnv(), windowsHide: true });
    job.child = child;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error(timeoutText(stage, seconds)));
    }, seconds * 1000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job.child === child) job.child = null;
      if (error) reject(error); else resolve();
    }
    function consume(line) {
      if (!line.trim()) return;
      try { onEvent(JSON.parse(line)); } catch (_) { stderr = '检索脚本返回了无效状态'; }
    }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 100000) buffer = '';
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      consume(buffer);
      finish(code === 0 ? null : new Error(job.error || stderr || `检索脚本退出码 ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 产物判定（§4.4；与 tools/literature-common.py detect_completed_stages 同表）
// ---------------------------------------------------------------------------

function extractionCoverage(jobDir) {
  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  let names = [];
  try { names = fs.readdirSync(inputsDir).filter(name => name.endsWith('.json')).sort(); } catch (_) { /* 未生成 */ }
  const coverage = { bundles: names.length, results: 0, pending: [], invalid: [] };
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    const payload = loadJsonFile(path.join(jobDir, 'extraction', `${stem}.json`));
    if (!payload) { coverage.pending.push(stem); continue; }
    const usable = payload.paper_id === stem && ['ok', 'partial', 'skipped'].includes(String(payload.status || '')) && Array.isArray(payload.rows);
    if (usable) coverage.results += 1; else coverage.invalid.push(stem);
  }
  return coverage;
}

function detectStagedArtifacts(jobDir) {
  const stages = {};
  const candidates = loadJsonFile(path.join(jobDir, 'candidates.json'));
  stages.discover = candidates && candidates.discovery_complete !== false && Array.isArray(candidates.batches) && candidates.batches.length ? 'done' : 'pending';

  const dedupe = loadJsonFile(path.join(jobDir, 'dedupe', 'dedupe.json'));
  stages.dedupe = dedupe && Number.isInteger(dedupe.version) && dedupe.version >= 1 && Array.isArray(dedupe.groups) ? 'done' : 'pending';

  const status = loadJsonFile(path.join(jobDir, 'fulltext', 'status.json'));
  const items = status && Array.isArray(status.items) ? status.items : null;
  stages.fulltext = items && items.length && items.every(item => item && String(item.status || '') !== 'pending') ? 'done' : 'pending';

  const coverage = extractionCoverage(jobDir);
  stages.extract = coverage.bundles && !coverage.pending.length && !coverage.invalid.length ? 'done' : 'pending';

  const validation = loadJsonFile(path.join(jobDir, 'validation', 'validation.json'));
  stages.validate = validation && typeof validation === 'object' && !Array.isArray(validation) ? 'done' : 'pending';

  stages.export = fs.existsSync(path.join(jobDir, 'export', 'literature.xlsx')) && fs.existsSync(path.join(jobDir, 'export', 'parameters.xlsx')) ? 'done' : 'pending';

  const resumeStage = STAGES.find(stage => stages[stage] !== 'done') || null;
  return { stages, resumeStage };
}

//: 扫描任务目录内符合交付物模式的文件（interrupted 恢复时重建可下载清单）。
function scanDeliverables(jobDir) {
  const found = [];
  const visit = (dir, prefix, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relative === 'export/history') continue;
        visit(path.join(dir, entry.name), relative, depth + 1);
      } else if (entry.isFile() && isDeliverable(relative)) {
        found.push(relative);
      }
    }
  };
  visit(jobDir, '', 0);
  const rest = found.filter(name => name !== 'run_config.json').sort();
  return found.includes('run_config.json') ? ['run_config.json', ...rest] : rest;
}

//: 有效 schema = confirmations.json 最新一条 kind=fieldDefinitions（§3.2）。
function readEffectiveSchema(jobDir) {
  const data = loadJsonFile(path.join(jobDir, 'confirmations.json'));
  const records = data && Array.isArray(data.records) ? data.records : [];
  let latest = null;
  for (const record of records) {
    if (record && record.kind === 'fieldDefinitions' && Array.isArray(record.fields)) latest = record;
  }
  return latest;
}

//: extract 阶段的缺省 Python 半（网页线由 server.js 注入 CodexBridge 适配器；此处为无 LLM 回退）。
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

//: bundle 的 field_definitions 与当前有效 schema 不一致 → 需 --force 重建（§2.4.4/§4.4）。
function staleBundles(jobDir, schemaFields) {
  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  let names = [];
  try { names = fs.readdirSync(inputsDir).filter(name => name.endsWith('.json')); } catch (_) { return []; }
  const current = JSON.stringify(canonicalJson(schemaFields));
  const stale = [];
  for (const name of names) {
    const bundle = loadJsonFile(path.join(inputsDir, name));
    if (!bundle || !Array.isArray(bundle.field_definitions)) continue;
    if (JSON.stringify(canonicalJson(bundle.field_definitions)) !== current) stale.push(name);
  }
  return stale;
}

async function defaultExtractStage(root, job, python, onEvent) {
  const schema = readEffectiveSchema(job.dir);
  if (!schema) {
    onEvent({ type: 'attention', stage: 'awaiting_confirmation', message: '提取前需由研究者确认主题参数字段含义与单位；确认后点击继续。' });
    return;
  }
  const stale = staleBundles(job.dir, schema.fields);
  await runStageProcess(root, job, python, STAGE_SCRIPTS.extract, stale.length ? ['--prepare', '--force'] : ['--prepare'], onEvent);
  if (job.status !== 'running') return;
  const coverage = extractionCoverage(job.dir);
  if (!coverage.bundles) {
    onEvent({ type: 'error', message: '未找到可提取的文献：请先完成 fulltext 阶段并确认 fulltext/status.json 有已获取全文项。' });
    return;
  }
  if (coverage.pending.length) {
    onEvent({
      type: 'attention', stage: 'extraction',
      message: `提取输入包已生成（${coverage.bundles} 篇）。请在网页端完成提取，或在 extraction/ 放置结果后重跑。`,
      counts: { bundles: coverage.bundles, results: coverage.results, pending: coverage.pending.length }
    });
    return;
  }
  await runStageProcess(root, job, python, STAGE_SCRIPTS.extract, ['--check'], onEvent);
}

class LiteratureConnector {
  constructor(root, options = {}) {
    this.root = root;
    this.base = path.join(root, '.workbench', 'literature');
    this.jobs = new Map();
    this.prepare = options.prepare || ((job, progress) => preparePython(root, job, progress));
    this.search = options.search || null;
    this.extract = options.extract || null;
    this.openSource = options.openSource || (async (job, python, source) => {
      const raw = await runCommand(python, ['-u', path.join(this.root, 'tools', 'literature_browser.py'), '--open-source', source, '--output-dir', job.dir], { cwd: this.root, timeout: 45000 });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('检索浏览器未返回有效状态，请重试'); }
      if (!result || result.opened !== true || result.source !== source) throw new Error('无法打开对应检索页面，请检查本机浏览器环境');
      return result;
    });
  }

  public(job) {
    return { id: job.id, status: job.status, stage: job.stage, message: job.message,
      count: job.count, config: job.config, files: job.files, events: job.events, error: job.error,
      stages: job.stages, resumeStage: job.resumeStage, until: job.until, counters: job.counters,
      attention: sourceAttention(job.attention) };
  }

  persist(job) {
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(this.public(job), null, 2) + '\n');
  }

  update(job, stage, message) {
    if (job.status === 'cancelled' && stage !== 'cancelled') return;
    job.stage = stage;
    job.message = message;
    job.events.push({ at: new Date().toISOString(), stage, message });
    job.events = job.events.slice(-30);
    this.persist(job);
  }

  //: events.jsonl 全量审计流水（§4.2；网页路径唯一写入者 = 连接器）。
  appendEventLog(job, event) {
    try {
      const record = { at: new Date().toISOString(), type: String(event.type || ''), stage: String(event.stage || ''), message: String(event.message || '') };
      const extra = {};
      for (const [key, value] of Object.entries(event)) {
        if (!['type', 'stage', 'message'].includes(key)) extra[key] = value;
      }
      if (Object.keys(extra).length) record.extra = extra;
      fs.appendFileSync(path.join(job.dir, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    } catch (_) { /* 审计日志失败不影响任务本身 */ }
  }

  //: result.files → 模式校验 + 存在性校验通过才登记（§9.6/§21.2.5）。
  registerFiles(job, files) {
    for (const name of Array.isArray(files) ? files : []) {
      if (typeof name !== 'string' || !isDeliverable(name) || job.files.includes(name)) continue;
      const target = path.resolve(job.dir, name);
      if (!target.startsWith(job.dir + path.sep) || !fs.existsSync(target)) continue;
      job.files.push(name);
    }
  }

  //: fulltext 的 result.files 只含 status.json（I3 契约），正文文件按 items[].path 补登记。
  registerFulltextFiles(job) {
    const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
    const items = status && Array.isArray(status.items) ? status.items : [];
    this.registerFiles(job, items.map(item => item && item.path).filter(Boolean));
  }

  mergeCounters(job, stage, event) {
    const counters = job.counters || (job.counters = {});
    const counts = event && typeof event.counts === 'object' && event.counts ? event.counts : {};
    const integer = value => (Number.isInteger(value) ? value : null);
    if (stage === 'discover' && integer(event.count) !== null) counters.candidates = event.count;
    if (stage === 'dedupe' && integer(counts.groups) !== null) counters.uniqueGroups = counts.groups;
    if (stage === 'fulltext' && (integer(event.count) !== null || integer(counts.fetched) !== null)) {
      counters.fulltextFetched = integer(event.count) !== null ? event.count : counts.fetched;
    }
    if (stage === 'extract' && integer(event.count) !== null) counters.extractedPapers = event.count;
    if (stage === 'validate' && integer(counts.parameters_total) !== null) counters.parameterRows = counts.parameters_total;
    if (stage === 'export' && integer(event.count) !== null) counters.parameterRows = event.count;
  }

  onStageEvent(job, runId, stageKey, event) {
    if (!event || typeof event !== 'object') return;
    this.appendEventLog(job, event);
    if (Number.isInteger(runId) && job.runId !== runId) return; // 旧一代 run：只审计不改状态
    if (job.status === 'cancelled') return;
    if (event.type === 'stage') {
      this.update(job, String(event.stage || stageKey), String(event.message || '正在处理'));
      return;
    }
    if (event.type === 'attention') {
      job.status = 'needs_attention';
      job.resumeStage = stageKey;
      job.attention = sourceAttention(event);
      this.registerFiles(job, event.files);
      if (Number.isInteger(event.count)) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
      const label = String(event.stage || (stageKey === 'discover' ? 'verification' : stageKey));
      this.update(job, label, String(event.message || '需要人工处理'));
      return;
    }
    if (event.type === 'error') {
      job.status = 'failed';
      job.error = String(event.message || '检索失败');
      this.registerFiles(job, event.files);
      if (Number.isInteger(event.count)) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
      if (job.stages) job.stages[stageKey] = 'failed';
      job.resumeStage = stageKey;
      this.update(job, 'failed', job.error);
      return;
    }
    if (event.type === 'result') {
      job.count = Number.isInteger(event.count) ? event.count : 0;
      this.registerFiles(job, event.files);
      if (stageKey === 'fulltext') this.registerFulltextFiles(job);
      this.mergeCounters(job, stageKey, event);
      if (job.stages) job.stages[stageKey] = 'done';
      job.message = String(event.message || (stageKey === 'discover' ? `已保存 ${job.count} 条候选` : '阶段已完成'));
      this.persist(job);
    }
  }

  //: 通用阶段执行器（§9.6）：新阶段全部复用同一 NDJSON 协议。
  runStage(scriptName, extraArgs, job, onEvent) {
    return runStageProcess(this.root, job, job.python, scriptName, extraArgs, onEvent);
  }

  async runSingleStage(job, python, stage, runId) {
    job.python = python;
    const onEvent = event => this.onStageEvent(job, runId, stage, event);
    if (stage === 'discover' && this.search) return this.search(job, python, onEvent);
    if (stage === 'extract' && this.extract) return this.extract(job, python, onEvent);
    if (stage === 'extract') return defaultExtractStage(this.root, job, python, onEvent);
    const extraArgs = [];
    if (stage === 'discover') {
      if (job.resumeCurrent) extraArgs.push('--scrape-current');
      if (job.resumeRun) extraArgs.push('--resume');
    } else if (job.resumeRun) {
      extraArgs.push('--resume');
    }
    return this.runStage(STAGE_SCRIPTS[stage], extraArgs, job, onEvent);
  }

  async run(job, fromStage = 'discover', until = 'discover') {
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1;
    job.runId = runId;
    job.activeStage = fromStage;
    job.resumeStage = null;
    try {
      const python = await this.prepare(job, (stage, message) => this.update(job, stage, message));
      if (job.runId !== runId || job.status !== 'running') return;
      for (let index = STAGES.indexOf(fromStage); index <= STAGES.indexOf(until); index += 1) {
        const stage = STAGES[index];
        if (job.runId !== runId || job.status !== 'running') return;
        job.activeStage = stage;
        if (job.stages) job.stages[stage] = 'running';
        this.persist(job);
        await this.runSingleStage(job, python, stage, runId);
        if (job.runId !== runId) return; // 新一代 run 已接管（如 failed 后立即 advance）
        if (job.status === 'cancelled') return;
        if (job.status === 'needs_attention' || job.status === 'failed') {
          job.resumeStage = stage;
          this.persist(job);
          return;
        }
        if (job.stages && job.stages[stage] !== 'done') {
          // 干净退出但无收尾事件 → 失败（§2.2）
          job.status = 'failed';
          job.stages[stage] = 'failed';
          job.resumeStage = stage;
          job.error = stage === 'discover' ? '检索脚本未返回结果' : '阶段脚本未返回结果';
          this.update(job, 'failed', job.error);
          return;
        }
      }
      const next = STAGES.find(stage => job.stages[stage] !== 'done') || null;
      job.status = 'completed';
      job.activeStage = null;
      job.resumeStage = next;
      this.update(job, 'completed', job.message || '阶段完成');
    } catch (error) {
      if (job.runId !== runId) return;
      if (job.status === 'cancelled') return;
      const stage = job.activeStage;
      if (stage && job.stages && job.stages[stage] !== 'done') job.stages[stage] = 'failed';
      if (!job.resumeStage) job.resumeStage = stage || 'discover';
      if (job.status === 'failed' && job.error) { this.persist(job); return; }
      job.status = 'failed';
      job.error = error.message;
      this.update(job, 'failed', job.error);
    }
  }

  start(rawConfig, resumeCurrent = false, until = null) {
    const config = normalizeConfig(rawConfig, { executable: true });
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.browserOpening)) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const boundary = until == null || until === '' ? 'discover' : String(until);
    if (!STAGES.includes(boundary)) throw new Error('阶段边界必须是 discover–export 的有效阶段名');
    const id = randomUUID();
    const job = { id, dir: path.join(this.base, id), config, resumeCurrent: resumeCurrent === true, status: 'running', stage: 'queued',
      message: '任务已排队', count: 0, files: ['run_config.json'], events: [], error: null, child: null,
      stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])), resumeStage: null, until: boundary,
      counters: {}, limits: resolveLimits(config), activeStage: null, python: null, resumeRun: false, attention: null };
    this.jobs.set(id, job);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'run_config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    this.update(job, 'queued', '准备首批候选检索');
    void this.run(job, 'discover', boundary);
    return this.public(job);
  }

  //: 从磁盘装载历史任务（advance 续跑用）；interrupted（服务重启遗留 running）在此重写。
  loadPersisted(id) {
    const dir = path.join(this.base, id);
    const file = path.join(dir, 'job.json');
    if (!fs.existsSync(file)) throw new Error('检索任务不存在');
    const saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    const diskConfig = loadJsonFile(path.join(dir, 'run_config.json'));
    const config = saved.config || diskConfig || null;
    const job = {
      id, dir, config, resumeCurrent: false, status: saved.status, stage: saved.stage, message: saved.message,
      count: Number.isInteger(saved.count) ? saved.count : 0,
      files: Array.isArray(saved.files) ? saved.files.filter(isDeliverable) : ['run_config.json'],
      events: Array.isArray(saved.events) ? saved.events.slice(-30) : [],
      error: saved.error || null, child: null,
      stages: saved.stages && typeof saved.stages === 'object' ? saved.stages : null,
      resumeStage: typeof saved.resumeStage === 'string' && STAGES.includes(saved.resumeStage) ? saved.resumeStage : null,
      until: typeof saved.until === 'string' ? saved.until : null,
      counters: saved.counters && typeof saved.counters === 'object' ? saved.counters : {},
      limits: resolveLimits(saved.config || diskConfig), activeStage: null, python: null, resumeRun: true,
      attention: sourceAttention(saved.attention), browserOpening: false
    };
    const detected = detectStagedArtifacts(dir);
    if (saved.status === 'running') {
      // 服务重启遗留 running → interrupted 改写（§4.3），按产物重建 stages/resumeStage 以便续跑。
      job.status = 'failed';
      job.stage = 'interrupted';
      job.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      job.files = scanDeliverables(dir);
      job.stages = detected.stages;
      job.resumeStage = detected.resumeStage;
    } else {
      // 新格式（含 stages/resumeStage 字段）按登记值；缺失（旧任务）才按产物推导。
      if (!job.stages) job.stages = detected.stages;
      if (!Object.prototype.hasOwnProperty.call(saved, 'resumeStage')) job.resumeStage = detected.resumeStage;
    }
    this.jobs.set(id, job);
    return job;
  }

  //: POST /api/literature/advance（§21.2.2）：从 resumeStage 续跑，缺省 until=export。
  advance(id, options = {}) {
    const requested = options && typeof options === 'object' ? options : {};
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    let until = requested.until == null || requested.until === '' ? 'export' : String(requested.until);
    if (!STAGES.includes(until)) throw new Error('阶段边界必须是 discover–export 的有效阶段名');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.browserOpening)) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if ((requested.until == null || requested.until === '') && job.status === 'needs_attention' && job.resumeStage === 'discover' && job.attention) until = job.until || 'discover';
    if (job.status === 'cancelled') throw new Error('任务已停止，不能继续；请发起新检索');
    if (job.status === 'running') throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const stage = job.resumeStage || null;
    if (!stage) throw new Error('该任务已完成全部阶段');
    if (!['completed', 'needs_attention', 'failed'].includes(job.status)) throw new Error('该任务已完成全部阶段');
    if (job.browserOpening) throw new Error('正在打开检索页面，请稍后继续');
    if (STAGES.indexOf(until) < STAGES.indexOf(stage)) throw new Error('请选择当前待运行阶段或之后的阶段');
    if (requested.confirmations != null) this.appendConfirmations(job, requested.confirmations);
    job.resumeRun = true;
    if (stage === 'discover' && (job.attention || job.stage === 'verification' || job.stage === 'interrupted')) job.resumeCurrent = true;
    job.attention = null;
    job.status = 'running';
    job.error = null;
    job.until = until;
    this.update(job, stage, `继续${STAGE_LABELS[stage] || stage}`);
    void this.run(job, stage, until);
    return this.public(job);
  }

  async openLogin(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if (job.status !== 'needs_attention' || job.resumeStage !== 'discover') throw new Error('当前任务没有等待登录或验证的检索来源');
    if ([...this.jobs.values()].some(item => item.status === 'running' || item.browserOpening)) throw new Error('检索浏览器正在使用，请稍后再打开');
    const attention = sourceAttention(job.attention);
    const source = attention && job.config?.sources?.includes(attention.source) ? attention.source : null;
    if (!source) throw new Error('缺少当前等待来源，请先继续任务以重新检查');
    job.browserOpening = true;
    try {
      const python = job.python || await this.prepare(job, () => {});
      if (job.status !== 'needs_attention') throw new Error('任务状态已变化，请刷新后再操作');
      const result = await this.openSource(job, python, source);
      if (!result || result.opened !== true || result.source !== source) throw new Error('检索页面打开失败');
      return { opened: true, source, label: executableSources().find(item => item.key === source).label };
    } finally { job.browserOpening = false; }
  }

  //: 追加确认记录（append-only，原子重写；§3.2）。
  appendConfirmations(job, confirmations) {
    const fields = confirmations && Array.isArray(confirmations.fields) ? confirmations.fields : null;
    const valid = fields && fields.length && fields.length <= 50 && fields.every(item =>
      item && typeof item === 'object' && !Array.isArray(item) && typeof item.key === 'string' && item.key.trim());
    if (!valid) throw new Error('字段确认内容无效');
    const file = path.join(job.dir, 'confirmations.json');
    const existing = loadJsonFile(file);
    const records = existing && Array.isArray(existing.records) ? existing.records : [];
    records.push({ at: new Date().toISOString(), by: 'researcher', kind: 'fieldDefinitions', fields, note: '' });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ records }, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
  }

  snapshot(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const live = this.jobs.get(id);
    if (live) return this.public(live);
    const dir = path.join(this.base, id);
    const file = path.join(dir, 'job.json');
    if (!fs.existsSync(file)) throw new Error('检索任务不存在');
    const saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    if (saved.status === 'running') {
      saved.status = 'failed'; saved.stage = 'interrupted';
      saved.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      saved.files = scanDeliverables(dir);
      const detected = detectStagedArtifacts(dir);
      saved.stages = detected.stages;
      saved.resumeStage = detected.resumeStage;
    }
    return saved;
  }

  //: GET /api/literature/jobs（§21.2.3）：按 job.json mtime 倒序，损坏记录跳过。
  list(limit) {
    const size = Math.min(50, Math.max(1, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : 20));
    if (!fs.existsSync(this.base)) return [];
    const entries = [];
    for (const name of fs.readdirSync(this.base)) {
      if (!ID.test(name)) continue;
      const file = path.join(this.base, name, 'job.json');
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      const saved = loadJsonFile(file);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      entries.push({ mtime: stat.mtimeMs, job: saved });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, size).map(entry => entry.job);
  }

  download(id, name) {
    const job = this.snapshot(id);
    if (!isDeliverable(name) || !Array.isArray(job.files) || !job.files.includes(name)) throw new Error('结果文件不存在');
    const dir = path.join(this.base, id);
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) throw new Error('结果文件不可下载');
    let stat;
    try { stat = fs.lstatSync(file); } catch (_) { throw new Error('结果文件不存在'); }
    if (stat.isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('结果文件不可下载');
    return file;
  }

  cancel(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if (!job || !['running', 'needs_attention'].includes(job.status)) throw new Error('检索任务未在运行');
    job.status = 'cancelled';
    if (job.child) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    const discover = !job.activeStage || job.activeStage === 'discover';
    this.update(job, 'cancelled', discover ? '检索已停止；持久浏览器保持打开' : '任务已停止；已完成的阶段产物保留');
    return this.public(job);
  }
}

module.exports = { LiteratureConnector, STAGES, DELIVERABLE_PATTERNS, __internals: { preparePython, requirementsHash, detectStagedArtifacts, extractionCoverage, resolveLimits } };
