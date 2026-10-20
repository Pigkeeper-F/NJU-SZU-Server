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
const { normalizeConfig, discoverBudget } = require('./literature-config');
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
  /^processing-basis\.json$/,
  /^dedupe\/dedupe\.(?:json|csv)$/,
  /^fulltext\/status\.json$/,
  /^fulltext\/review\.json$/,
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
  limits.discover = discoverBudget(config);
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

function selectedSources(config) {
  const known = new Set(executableSources().map(source => source.key));
  return [...new Set((Array.isArray(config?.sources) ? config.sources : []).filter(source => typeof source === 'string' && known.has(source)))];
}

function deferredSources(value, config) {
  const selected = new Set(selectedSources(config));
  return [...new Set((Array.isArray(value) ? value : []).filter(source => selected.has(source)))];
}

function checkpointDeferredSources(dir, config, fallback = []) {
  const state = loadJsonFile(path.join(dir, 'discovery-state.json'));
  return deferredSources(state && Object.hasOwn(state, 'deferred_sources') ? state.deferred_sources : fallback, config);
}

function checkpointDeferredOnly(dir, config) {
  const state = loadJsonFile(path.join(dir, 'discovery-state.json'));
  const selected = selectedSources(config), queue = state?.deferred_sources;
  if (!selected.length || !Array.isArray(queue) || !queue.length || new Set(queue).size !== queue.length
      || queue.some(source => !selected.includes(source) || state?.sources?.[source]?.status !== 'attention')
      || !queue.includes(state?.pending_source)) return false;
  const remaining = selected.filter(source => !['ok', 'no_results'].includes(state?.sources?.[source]?.status));
  return remaining.length > 0 && remaining.every(source => queue.includes(source) && state?.sources?.[source])
    && queue.every(source => remaining.includes(source));
}

function candidateRecords(document) {
  const records = Array.isArray(document?.records) ? document.records : document?.results;
  return Array.isArray(records) && records.every(record => record && typeof record === 'object' && !Array.isArray(record)) ? records : null;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function processingBasisFor(dir, config) {
  const basis = loadJsonFile(path.join(dir, 'processing-basis.json'));
  if (!basis || basis.version !== 1 || !ID.test(basis.parentJobId || '')
      || !Number.isSafeInteger(basis.candidateCount) || basis.candidateCount <= 0
      || typeof basis.createdAt !== 'string' || !Number.isFinite(Date.parse(basis.createdAt))
      || !Array.isArray(basis.deferredSources) || !basis.deferredSources.length
      || JSON.stringify(deferredSources(basis.deferredSources, config)) !== JSON.stringify(basis.deferredSources)) return null;
  try {
    const candidates = fs.readFileSync(path.join(dir, 'candidates.json'));
    const records = candidateRecords(JSON.parse(candidates.toString('utf8')));
    if (!records || records.length !== basis.candidateCount || sha256(candidates) !== basis.candidateSnapshotSha256
        || sha256(fs.readFileSync(path.join(dir, 'run_config.json'))) !== basis.configSnapshotSha256
        || sha256(fs.readFileSync(path.join(dir, 'candidates.csv'))) !== basis.candidateCsvSnapshotSha256) return null;
  } catch (_) { return null; }
  return { parentJobId: basis.parentJobId, candidateCount: basis.candidateCount,
    deferredSources: [...basis.deferredSources], candidateSnapshotSha256: basis.candidateSnapshotSha256, createdAt: basis.createdAt };
}

function executionOrder(config, queue) {
  return [...selectedSources(config).filter(source => !queue.includes(source)), ...queue];
}

function fulltextReviewEligible(job, dir) {
  if (!job || job.deletedAt || job.status === 'running' || job.child || job.browserOpening) return false;
  const status = loadJsonFile(path.join(dir, 'fulltext', 'status.json'));
  const dedupe = loadJsonFile(path.join(dir, 'dedupe', 'dedupe.json'));
  if (!Array.isArray(status?.items) || !Array.isArray(dedupe?.groups) || !dedupe.groups.length) return false;
  if (!(job.resumeStage === 'fulltext' || job.activeStage === 'fulltext' || job.stage === 'fulltext_review'
      || ['running', 'done', 'failed'].includes(job.stages?.fulltext))) return false;
  // A cache correction must never silently invalidate saved downstream work.
  for (const relative of ['extraction', 'validation', 'export']) {
    const directory = path.join(dir, relative);
    try { if (fs.readdirSync(directory).length) return false; } catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  return true;
}

const PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CNKI_RETRY_STATUSES = new Set(['pending', 'needs_attention', 'unavailable', 'abstract_only']);

function hasCnkiRetryScope(job) {
  return typeof job?.cnkiRetryPaperId === 'string' && PAPER_ID.test(job.cnkiRetryPaperId);
}

function restoreCnkiRetryScope(job, interrupted = false) {
  if (!hasCnkiRetryScope(job)) return;
  // Saved material completeness cannot promote a scoped single-paper action
  // into extraction. Only an explicit finished retry or offline review may
  // release this marker, including a crash after its result was persisted.
  job.resumeStage = 'fulltext'; job.until = 'fulltext'; job.activeStage = null;
  job.stages = { ...(job.stages || {}), fulltext: 'pending' };
  if (interrupted) {
    job.status = 'failed'; job.stage = 'interrupted'; job.attention = null;
    job.error = '本地服务已重启，单篇知网全文获取已暂停；已保存材料保留。';
    job.message = '单篇知网全文获取中断，范围仍限这一篇；若文件已保存请先复核全文，否则继续这篇知网文献，不会进入提取。';
  }
}

function cnkiRetryItems(job, dir) {
  if (!['needs_attention', 'failed', 'completed'].includes(job?.status) || !fulltextReviewEligible(job, dir)) return [];
  const report = loadJsonFile(path.join(dir, 'candidates.json'));
  const records = candidateRecords(report);
  const dedupe = loadJsonFile(path.join(dir, 'dedupe', 'dedupe.json'));
  const status = loadJsonFile(path.join(dir, 'fulltext', 'status.json'));
  if (!records || !Array.isArray(dedupe?.groups) || !Array.isArray(status?.items)) return [];
  const items = [], seen = new Set(), normalizeTitle = value => String(value || '').trim().replace(/\s+/g, ' ');
  for (const group of dedupe.groups) {
    const id = group?.canonical_id;
    if (typeof id !== 'string' || !PAPER_ID.test(id) || seen.has(id)
        || dedupe.groups.filter(other => other?.canonical_id === id).length !== 1) continue;
    seen.add(id);
    // Match exactly the canonical target chosen by fulltext.load_targets. Do
    // not convert another source's merged group into a CNKI download target.
    const members = Array.isArray(group.records) ? group.records.filter(record => record?.candidate_id === id) : [];
    const originals = records.filter(record => record.candidate_id === id);
    const states = status.items.filter(item => item?.paper_id === id);
    if (members.length !== 1 || originals.length !== 1 || states.length !== 1) continue;
    const member = members[0], original = originals[0], state = states[0];
    const title = normalizeTitle(group.title || member.title);
    if (member.source_key !== 'cnki' || original.source_key !== 'cnki' || !title || title.length > 500
        || normalizeTitle(member.title) !== normalizeTitle(original.title) || title !== normalizeTitle(original.title)
        || !CNKI_RETRY_STATUSES.has(state.status) || normalizeTitle(state.title) !== title) continue;
    // Reasons are fixed UI explanations, never persisted URLs or session data.
    const reason = state.status === 'abstract_only' ? '目前仅有摘要，尚未取得全文'
      : state.status === 'needs_attention' ? '原全文页面需要处理或核对'
        : state.status === 'pending' ? '尚未处理这篇文献' : '尚未取得可确认的全文，需要补充官方入口';
    items.push({ id, title, status: state.status, reason });
    if (items.length >= 100) break;
  }
  return items;
}

function existingPython(root, job) {
  const python = job.python || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('本地 Python 环境尚未准备；全文缓存复核不会联网安装依赖。');
  return python;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.job?.status === 'cancelled') { reject(new Error('检索已停止')); return; }
    const child = spawn(command, args, { cwd: options.cwd, env: { ...pythonEnv(), ...options.environment }, windowsHide: true });
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

const pythonProcessSpecs = new Map();

async function stagePythonProcessSpec(root, python) {
  if (process.platform !== 'win32' || !path.isAbsolute(python) || !fs.existsSync(python)) return { executable: python, environment: {} };
  const key = path.resolve(python).toLowerCase();
  if (!pythonProcessSpecs.has(key)) {
    const pending = (async () => {
      // CPython's Windows venv redirector has a different PID from its script.
      // Probe only interpreter identity; never print these internal paths to UI.
      const raw = await runCommand(python, ['-c', 'import json,sys; print(json.dumps({"baseExecutable":getattr(sys,"_base_executable",sys.executable),"launcher":sys.executable}))'],
        { cwd: root, timeout: 5000 });
      let value;
      try { value = JSON.parse(raw); } catch (_) { throw new Error('无法确认 Python 阶段进程，请检查本机运行环境'); }
      if (![value?.baseExecutable, value?.launcher].every(name => typeof name === 'string' && path.isAbsolute(name)
          && !/[\r\n\0]/.test(name) && fs.existsSync(name))) throw new Error('无法确认 Python 阶段进程，请检查本机运行环境');
      return { executable: value.baseExecutable, environment: { __PYVENV_LAUNCHER__: value.launcher } };
    })();
    pythonProcessSpecs.set(key, pending);
    pending.catch(() => { if (pythonProcessSpecs.get(key) === pending) pythonProcessSpecs.delete(key); });
  }
  return pythonProcessSpecs.get(key);
}

//: 通用阶段执行器（§9.6）：spawn python -u <script> --config/--output-dir + stdout NDJSON。
//: discover 沿用既有 180s 文案；其余阶段用新超时文案（§8.3）。
async function runStageProcess(root, job, python, scriptName, extraArgs, onEvent) {
  const spec = await stagePythonProcessSpec(root, python);
  // A stop during the fixed interpreter probe must not launch a late stage.
  if (job.status !== 'running') throw new Error('任务已停止，阶段未启动');
  return new Promise((resolve, reject) => {
    const stage = job.activeStage || 'discover';
    const seconds = job.limits?.[stage] || STAGE_TIMEOUTS[stage] || 180;
    const script = path.join(root, 'tools', scriptName);
    const args = ['-u', script, '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir, ...(extraArgs || [])];
    const child = spawn(spec.executable, args, { cwd: root, env: { ...pythonEnv(), ...spec.environment }, windowsHide: true });
    job.child = child;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      const error = new Error(timeoutText(stage, seconds));
      error.code = 'LITERATURE_STAGE_TIMEOUT';
      finish(error);
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
  const config = loadJsonFile(path.join(jobDir, 'run_config.json'));
  stages.discover = processingBasisFor(jobDir, config) || (candidates && candidates.discovery_complete !== false && !checkpointDeferredSources(jobDir, config).length
    && Array.isArray(candidates.batches) && candidates.batches.length) ? 'done' : 'pending';

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
    this.prepareOffline = options.prepareOffline || (async job => existingPython(this.root, job));
    this.openFulltext = options.openFulltext || (async (job, python) => {
      const spec = await stagePythonProcessSpec(this.root, python);
      if (job.status !== 'needs_attention' || job.resumeStage !== 'fulltext') throw new Error('任务状态已变化，请刷新后再操作');
      const raw = await runCommand(spec.executable, ['-u', path.join(this.root, 'tools', 'literature_fulltext.py'),
        '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir, '--open-current'],
      { cwd: this.root, timeout: 15000, environment: spec.environment });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('全文任务页未返回有效状态，请重试'); }
      if (result?.opened !== true) throw new Error('全文任务页尚未打开，请先显式继续获取全文');
      return result;
    });
    this.openSource = options.openSource || (async (job, python, source) => {
      const raw = await runCommand(python, ['-u', path.join(this.root, 'tools', 'literature_browser.py'), '--open-source', source, '--output-dir', job.dir], { cwd: this.root, timeout: 45000 });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('检索浏览器未返回有效状态，请重试'); }
      if (!result || result.opened !== true || result.source !== source) throw new Error('无法打开对应检索页面，请检查本机浏览器环境');
      return result;
    });
  }

  public(job) {
    const queue = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
    return { id: job.id, status: job.status, stage: job.stage, message: job.message,
      count: job.count, config: job.config, files: job.files, events: job.events, error: job.error,
      stages: job.stages, resumeStage: job.resumeStage, until: job.until, counters: job.counters, activeStage: job.activeStage || null,
      attention: sourceAttention(job.attention), deferredSources: queue, deferredOnly: checkpointDeferredOnly(job.dir, job.config),
      executionOrder: executionOrder(job.config, queue), processingBasis: job.processingBasis || null, deletedAt: job.deletedAt || null,
      canReviewFulltext: fulltextReviewEligible(job, job.dir), cnkiRetryItems: cnkiRetryItems(job, job.dir),
      cnkiRetryPaperId: typeof job.cnkiRetryPaperId === 'string' && PAPER_ID.test(job.cnkiRetryPaperId) ? job.cnkiRetryPaperId : null };
  }

  persist(job) {
    job.deferredSources = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
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

  syncFulltextSnapshot(job) {
    const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
    if (!Array.isArray(status?.items)) return;
    const counts = Object.fromEntries(['fetched_pdf', 'fetched_html', 'abstract_only', 'unavailable', 'needs_attention', 'pending'].map(key => [key, 0]));
    for (const item of status.items) if (item && Object.hasOwn(counts, item.status)) counts[item.status]++;
    const count = counts.fetched_pdf + counts.fetched_html;
    job.count = count; this.mergeCounters(job, 'fulltext', { count, counts });
    this.registerFiles(job, ['fulltext/status.json']); this.registerFulltextFiles(job);
  }

  mergeCounters(job, stage, event) {
    const counters = job.counters || (job.counters = {});
    const counts = event && typeof event.counts === 'object' && event.counts ? event.counts : {};
    const integer = value => (Number.isInteger(value) ? value : null);
    if (stage === 'discover' && integer(event.count) !== null) counters.candidates = event.count;
    if (stage === 'dedupe' && integer(counts.groups) !== null) counters.uniqueGroups = counts.groups;
    if (['fulltext', 'fulltext_review'].includes(stage) && (integer(event.count) !== null || integer(counts.fetched) !== null)) {
      counters.fulltextFetched = integer(event.count) !== null ? event.count : counts.fetched;
    }
    if (['fulltext', 'fulltext_review'].includes(stage)) {
      for (const [field, key] of Object.entries({ fetched_pdf: 'fulltextPdf', fetched_html: 'fulltextHtml',
        abstract_only: 'fulltextAbstract', unavailable: 'fulltextUnavailable', needs_attention: 'fulltextAttention', pending: 'fulltextPending' })) {
        if (integer(counts[field]) !== null) counters[key] = counts[field];
      }
    }
    if (stage === 'extract' && integer(event.count) !== null) counters.extractedPapers = event.count;
    if (stage === 'validate' && integer(counts.parameters_total) !== null) counters.parameterRows = counts.parameters_total;
    if (stage === 'export' && integer(event.count) !== null) counters.parameterRows = event.count;
  }

  pauseEndDiscovery(job, message, attention = null) {
    this.registerFiles(job, scanDeliverables(job.dir));
    const candidates = loadJsonFile(path.join(job.dir, 'candidates.json'));
    const count = Number.isSafeInteger(candidates?.count) && candidates.count >= 0
      ? candidates.count : Array.isArray(candidates?.records) ? candidates.records.length : null;
    if (count !== null) { job.count = count; this.mergeCounters(job, 'discover', { count }); }
    job.status = 'needs_attention';
    job.error = null;
    job.resumeStage = 'discover';
    job.attention = sourceAttention(attention);
    if (job.stages) job.stages.discover = 'pending';
    const note = `${message} 已有分页结果保留，尚未确认末页；处理后点击“检查并继续”。`;
    this.appendEventLog(job, { type: 'attention', stage: 'interrupted', message: note });
    this.update(job, 'interrupted', note);
  }

  onStageEvent(job, runId, stageKey, event) {
    if (!event || typeof event !== 'object') return;
    this.appendEventLog(job, event);
    if (Number.isInteger(runId) && job.runId !== runId) return; // 旧一代 run：只审计不改状态
    if (job.status === 'cancelled') return;
    if (stageKey === 'discover' && Object.hasOwn(event, 'deferred_sources')) {
      job.deferredSources = deferredSources(event.deferred_sources, job.config);
    }
    if (event.type === 'stage') {
      if (stageKey === 'discover' && Number.isSafeInteger(event.count) && event.count >= 0) {
        job.count = event.count;
        this.mergeCounters(job, stageKey, event);
      }
      this.update(job, String(event.stage || stageKey), String(event.message || '正在处理'));
      return;
    }
    if (event.type === 'attention') {
      job.status = 'needs_attention';
      job.resumeStage = stageKey;
      if (job.stages && event.stage !== 'awaiting_confirmation') job.stages[stageKey] = 'pending';
      job.attention = sourceAttention(event);
      this.registerFiles(job, event.files);
      if (Number.isInteger(event.count)) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
      if (stageKey === 'fulltext') this.syncFulltextSnapshot(job);
      const label = String(event.stage || (stageKey === 'discover' ? 'verification' : stageKey));
      this.update(job, label, String(event.message || '需要人工处理'));
      return;
    }
    if (event.type === 'error') {
      if (stageKey === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
        this.registerFiles(job, event.files);
        if (Number.isSafeInteger(event.count) && event.count >= 0) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
        this.pauseEndDiscovery(job, String(event.message || '本页检索遇到问题，已暂停。'), { source: event.source, reason: 'results_unrecognized' });
        return;
      }
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
      if (stageKey === 'discover') {
        const queue = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
        const candidates = loadJsonFile(path.join(job.dir, 'candidates.json'));
        if (queue.length || event.discovery_complete === false || candidates?.discovery_complete === false) {
          const state = loadJsonFile(path.join(job.dir, 'discovery-state.json'));
          this.onStageEvent(job, runId, stageKey, { type: 'attention', stage: 'verification',
            source: state?.pending_source || queue[0], reason: state?.pending_reason || 'results_unrecognized',
            message: '仍有暂缓或未完成来源，已有候选保留；请继续补检待处理来源后再进入去重。',
            count: event.count, files: event.files, deferred_sources: queue });
          return;
        }
      }
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
    if (stage === 'discover' && this.search) {
      try { return await this.search(job, python, onEvent); }
      finally { job.deferSource = null; }
    }
    if (stage === 'extract' && this.extract) return this.extract(job, python, onEvent);
    if (stage === 'extract') return defaultExtractStage(this.root, job, python, onEvent);
    const extraArgs = [];
    if (stage === 'discover') {
      if (job.resumeCurrent) extraArgs.push('--scrape-current');
      if (job.resumeRun) extraArgs.push('--resume');
      if (job.deferSource) extraArgs.push('--defer-source', job.deferSource);
    } else if (job.resumeRun) {
      extraArgs.push('--resume');
    }
    try { return await this.runStage(STAGE_SCRIPTS[stage], extraArgs, job, onEvent); }
    finally { if (stage === 'discover') job.deferSource = null; }
  }

  async run(job, fromStage = 'discover', until = 'discover') {
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再执行');
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
          if (stage === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
            this.pauseEndDiscovery(job, '检索进程未返回明确结束结果，已暂停。');
            return;
          }
          // 干净退出但无收尾事件 → 失败（§2.2）
          job.status = 'failed';
          job.stages[stage] = 'failed';
          job.resumeStage = stage;
          job.error = stage === 'discover' ? '检索脚本未返回结果' : '阶段脚本未返回结果';
          this.update(job, 'failed', job.error);
          return;
        }
        if (stage === 'fulltext' && index < STAGES.indexOf(until)) {
          job.status = 'needs_attention';
          job.resumeStage = 'extract';
          job.attention = null;
          this.update(job, 'fulltext_ready', '全文获取阶段已结束；请核对正文、摘要及待补充明细，确认提取字段后显式继续提取。');
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
      if (stage === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
        if (job.status === 'needs_attention') { this.persist(job); return; }
        const message = error.code === 'LITERATURE_STAGE_TIMEOUT'
          ? '本次检索达到单次运行时间保护，已暂停。'
          : '本地检索环境或进程遇到问题，已暂停；请检查网络和运行环境。';
        this.pauseEndDiscovery(job, message);
        return;
      }
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
      counters: {}, limits: resolveLimits(config), activeStage: null, python: null, resumeRun: false, attention: null,
      deferredSources: [], deferSource: null };
    this.jobs.set(id, job);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'run_config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    this.update(job, 'queued', '准备首批候选检索');
    void this.run(job, 'discover', boundary);
    return this.public(job);
  }

  continueAvailable(id, options = {}) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const until = options?.until;
    if (!STAGES.slice(1).includes(until)) throw new Error('后续处理阶段必须为 dedupe–export');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请等待或停止后重试');
    }
    const parentDir = path.join(this.base, id);
    const parent = this.jobs.get(id) || loadJsonFile(path.join(parentDir, 'job.json'));
    if (!parent) throw new Error('检索任务不存在');
    if (parent.deletedAt) throw new Error('该任务已删除，请先恢复后再处理');
    if (!['needs_attention', 'failed', 'cancelled'].includes(parent.status) || parent.resumeStage !== 'discover'
        || parent.child || parent.browserOpening) throw new Error('只能从已暂停的检索任务建立后续处理');
    let configBytes, candidateBytes, csvBytes, config, candidates;
    try {
      configBytes = fs.readFileSync(path.join(parentDir, 'run_config.json'));
      candidateBytes = fs.readFileSync(path.join(parentDir, 'candidates.json'));
      csvBytes = fs.readFileSync(path.join(parentDir, 'candidates.csv'));
      config = JSON.parse(configBytes.toString('utf8'));
      candidates = JSON.parse(candidateBytes.toString('utf8'));
    } catch (_) { throw new Error('已保存候选或冻结配置不完整，无法建立后续处理'); }
    if (!checkpointDeferredOnly(parentDir, config)) throw new Error('仍有未暂缓的待检索来源，请先处理或暂缓后再继续');
    const records = candidateRecords(candidates);
    if (!records?.length || (Object.hasOwn(candidates, 'count') && candidates.count !== records.length)) {
      throw new Error('没有可用的已保存候选，或候选数量与文件不一致');
    }
    const basis = { parentJobId: id, candidateCount: records.length,
      deferredSources: checkpointDeferredSources(parentDir, config), candidateSnapshotSha256: sha256(candidateBytes),
      createdAt: new Date().toISOString() };
    const newId = randomUUID(), dir = path.join(this.base, newId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of [['run_config.json', configBytes], ['candidates.json', candidateBytes], ['candidates.csv', csvBytes]]) {
      fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(dir, 'processing-basis.json'), JSON.stringify({ version: 1, ...basis,
      configSnapshotSha256: sha256(configBytes), candidateCsvSnapshotSha256: sha256(csvBytes) }, null, 2) + '\n', { flag: 'wx' });
    const job = { id: newId, dir, config, resumeCurrent: false, status: 'running', stage: 'queued',
      message: `基于现有 ${records.length} 条候选建立后续处理；部分来源仍待补检`, count: records.length,
      files: ['run_config.json', 'candidates.json', 'candidates.csv', 'processing-basis.json'], events: [], error: null, child: null,
      stages: Object.fromEntries(STAGES.map(stage => [stage, stage === 'discover' ? 'done' : 'pending'])),
      resumeStage: 'dedupe', until, counters: { candidates: records.length }, limits: resolveLimits(config),
      activeStage: null, python: null, resumeRun: false, attention: null, deferredSources: [], deferSource: null,
      processingBasis: basis };
    this.jobs.set(newId, job);
    this.update(job, 'queued', job.message);
    void this.run(job, 'dedupe', until);
    return this.public(job);
  }

  reviewFulltext(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请先停止或等待结束后复核');
    }
    const dir = path.join(this.base, id);
    let saved = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
    if (!saved) throw new Error('检索任务不存在');
    if (!this.jobs.has(id) && saved.status === 'running' && hasCnkiRetryScope(saved)) saved = this.loadPersisted(id);
    if (!fulltextReviewEligible(saved, dir)) throw new Error('只能复核已停止的全文任务；需有全文状态和去重输入，且尚未生成提取、校验或导出成果');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    job.status = 'running'; job.error = null; job.activeStage = 'fulltext'; job.resumeStage = 'fulltext';
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1; job.runId = runId;
    this.update(job, 'fulltext_review', '正在离线复核已保存全文；不重新检索或下载。');
    void this.runFulltextReview(job, runId);
    return this.public(job);
  }

  async runFulltextReview(job, runId) {
    let reviewed = false, reviewError = null;
    try {
      const python = await this.prepareOffline(job);
      if (job.runId !== runId || job.status !== 'running') return;
      job.python = python;
      await this.runStage(STAGE_SCRIPTS.fulltext, ['--review-only'], job, event => {
        if (!event || typeof event !== 'object') return;
        this.appendEventLog(job, event);
        if (job.runId !== runId || job.status === 'cancelled') return;
        if (event?.type === 'result' && event.stage === 'fulltext_review') {
          reviewed = true;
          this.registerFiles(job, event.files); this.registerFulltextFiles(job);
          if (Number.isInteger(event.count)) job.count = event.count;
          this.mergeCounters(job, 'fulltext_review', event);
        } else if (event.type === 'error') reviewError = String(event.message || '全文缓存复核失败');
      });
      if (job.runId !== runId || job.status === 'cancelled') return;
      if (reviewError) throw new Error(reviewError);
      if (!reviewed) throw new Error('全文缓存复核未返回有效结果');
      if (job.cnkiRetryPaperId) {
        const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
        const item = status?.items?.find(item => item?.paper_id === job.cnkiRetryPaperId);
        // The researcher may stop just after the verified file and status were
        // saved but before the worker's result event. The offline review is the
        // gate that confirms that completed artifact and releases its scope.
        if (['fetched_pdf', 'fetched_html'].includes(item?.status)) job.cnkiRetryPaperId = null;
      }
      job.status = 'needs_attention'; job.resumeStage = 'fulltext'; job.activeStage = null; job.attention = null;
      job.stages = { ...(job.stages || {}), fulltext: 'pending' };
      this.update(job, 'fulltext_review', '缓存已复核，尚未继续获取全文。请核对复核报告，点击“继续获取全文”才会按原任务获取缺少材料；不会自动进入提取。');
    } catch (error) {
      if (job.runId !== runId || job.status === 'cancelled') return;
      job.status = 'failed'; job.resumeStage = 'fulltext'; job.activeStage = null; job.error = String(error.message || '全文缓存复核失败');
      this.update(job, 'fulltext_review', job.error);
    }
  }

  retryCnki(id, paperId) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    if (typeof paperId !== 'string' || !PAPER_ID.test(paperId)) throw new Error('无效的单篇文献标识');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请先停止或等待结束后重试单篇');
    }
    const dir = path.join(this.base, id);
    let saved = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
    if (!saved) throw new Error('检索任务不存在');
    if (!this.jobs.has(id) && saved.status === 'running' && hasCnkiRetryScope(saved)) saved = this.loadPersisted(id);
    if (saved.status === 'cancelled') throw new Error('任务已停止，请先复核已保存全文，再重试指定文献');
    const target = cnkiRetryItems(saved, dir).find(item => item.id === paperId);
    if (!target) throw new Error('只能重试已暂停全文任务中尚未取得的知网单篇；请核对原候选、去重及全文状态，已有下游成果时不可重试');
    if (saved.cnkiRetryPaperId && saved.cnkiRetryPaperId !== paperId) throw new Error('上一篇知网全文尚未处理完成，请先继续原单篇任务');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    job.status = 'running'; job.error = null; job.attention = null; job.activeStage = 'fulltext'; job.resumeStage = 'fulltext';
    job.stages = { ...(job.stages || {}), fulltext: 'running' };
    job.cnkiRetryPaperId = paperId; job.until = 'fulltext';
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1; job.runId = runId;
    this.update(job, 'fulltext', '仅重试这篇知网文献：' + target.title + '；不重新检索或进入提取。');
    void this.runCnkiRetry(job, runId, paperId);
    return this.public(job);
  }

  async runCnkiRetry(job, runId, paperId) {
    let receivedResult = false;
    try {
      const python = await this.prepare(job, (stage, message) => this.update(job, stage, message));
      if (job.runId !== runId || job.status !== 'running') return;
      job.python = python;
      await this.runStage(STAGE_SCRIPTS.fulltext, ['--resume', '--only', paperId, '--retry-unavailable', '--limit', '1'], job, event => {
        if (job.runId !== runId || job.status === 'cancelled') return;
        if (event?.type === 'result' && event.stage === 'fulltext') receivedResult = true;
        this.onStageEvent(job, runId, 'fulltext', event);
      });
      if (job.runId !== runId || job.status === 'cancelled') return;
      if (['needs_attention', 'failed'].includes(job.status)) { this.persist(job); return; }
      if (!receivedResult) throw new Error('单篇全文获取未返回有效结果，已有材料保留');
      job.status = 'needs_attention'; job.resumeStage = 'fulltext'; job.attention = null;
      job.cnkiRetryPaperId = null;
      job.stages.fulltext = 'pending';
      this.update(job, 'fulltext_ready', '本篇已处理，请核查全文状态；其他材料仍待处理或补充。仅执行了指定的这一篇，不重新检索或进入提取。');
    } catch (error) {
      if (job.runId !== runId || job.status === 'cancelled') return;
      job.status = 'failed'; job.resumeStage = 'fulltext'; job.stages.fulltext = 'failed';
      job.error = String(error.message || '单篇知网全文重试失败');
      this.update(job, 'failed', job.error);
    } finally {
      if (job.runId === runId) { job.activeStage = null; this.persist(job); }
    }
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
      attention: sourceAttention(saved.attention), browserOpening: false,
      deferredSources: checkpointDeferredSources(dir, config), deferSource: null, deletedAt: saved.deletedAt || null,
      processingBasis: processingBasisFor(dir, config)
    };
    job.cnkiRetryPaperId = typeof saved.cnkiRetryPaperId === 'string' && PAPER_ID.test(saved.cnkiRetryPaperId) ? saved.cnkiRetryPaperId : null;
    const detected = detectStagedArtifacts(dir);
    if (saved.status === 'running') {
      // 服务重启遗留 running → interrupted 改写（§4.3），按产物重建 stages/resumeStage 以便续跑。
      job.status = 'failed';
      job.stage = 'interrupted';
      job.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      job.files = scanDeliverables(dir);
      job.stages = detected.stages;
      job.resumeStage = detected.resumeStage;
      if (config?.searchMode === 'formal' && config.stopMode === 'end' && job.resumeStage === 'discover') {
        job.status = 'needs_attention';
        job.error = null;
        job.message = '本地服务已重启，检索已暂停；已有分页结果保留，尚未确认末页。请点击“检查并继续”恢复原任务。';
        job.attention = null;
      }
    } else {
      // 新格式（含 stages/resumeStage 字段）按登记值；缺失（旧任务）才按产物推导。
      if (!job.stages) job.stages = detected.stages;
      if (!Object.prototype.hasOwnProperty.call(saved, 'resumeStage')) job.resumeStage = detected.resumeStage;
    }
    restoreCnkiRetryScope(job, saved.status === 'running');
    this.jobs.set(id, job);
    return job;
  }

  //: POST /api/literature/advance（§21.2.2）：从 resumeStage 续跑，缺省 until=export。
  advance(id, options = {}) {
    const requested = options && typeof options === 'object' ? options : {};
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const stored = this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json'));
    if (stored?.deletedAt) throw new Error('该任务已删除，请先恢复后再执行');
    if (hasCnkiRetryScope(stored)) throw new Error('请使用“继续这篇知网文献”处理原单篇，不能扩大到其他文献');
    let until = requested.until == null || requested.until === '' ? 'export' : String(requested.until);
    if (!STAGES.includes(until)) throw new Error('阶段边界必须是 discover–export 的有效阶段名');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.browserOpening)) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const hasDefer = Object.hasOwn(requested, 'deferSource') && requested.deferSource !== undefined;
    if (hasDefer) {
      // Validate before loading/mutating a persisted job or appending any field
      // confirmations. Only Python changes the actual discovery checkpoint.
      const dir = path.join(this.base, id);
      const pending = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
      if (!pending) throw new Error('检索任务不存在');
      const config = pending.config || loadJsonFile(path.join(dir, 'run_config.json'));
      const attention = sourceAttention(pending.attention);
      const checkpoint = loadJsonFile(path.join(dir, 'discovery-state.json'));
      if (pending.status !== 'needs_attention' || pending.resumeStage !== 'discover') throw new Error('只能暂缓当前等待处理的检索来源');
      const originalUntil = pending.until || 'discover';
      if (!STAGES.includes(originalUntil)) throw new Error('原任务运行阶段无效，请先核对任务记录');
      if (requested.until != null && requested.until !== '' && String(requested.until) !== originalUntil) {
        throw new Error('暂缓来源只调整执行顺序，不能改变原任务的本次运行阶段');
      }
      until = originalUntil;
      if (typeof requested.deferSource !== 'string' || !selectedSources(config).includes(requested.deferSource)
          || requested.deferSource !== attention?.source || requested.deferSource !== checkpoint?.pending_source
          || checkpoint?.sources?.[requested.deferSource]?.status !== 'attention') {
        throw new Error('暂缓来源必须是原任务当前等待处理的已选来源');
      }
    }
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if ((requested.until == null || requested.until === '') && job.status === 'needs_attention' && job.resumeStage === 'discover') until = job.until || 'discover';
    if (job.status === 'cancelled') throw new Error('任务已停止，不能继续；请发起新检索');
    if (job.status === 'running') throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const stage = job.resumeStage || null;
    if (!stage) throw new Error('该任务已完成全部阶段');
    if (!['completed', 'needs_attention', 'failed'].includes(job.status)) throw new Error('该任务已完成全部阶段');
    if (job.browserOpening) throw new Error('正在打开检索页面，请稍后继续');
    if (STAGES.indexOf(until) < STAGES.indexOf(stage)) throw new Error('请选择当前待运行阶段或之后的阶段');
    if (requested.confirmations != null) this.appendConfirmations(job, requested.confirmations);
    job.resumeRun = true;
    job.deferSource = hasDefer ? requested.deferSource : null;
    if (hasDefer) job.resumeCurrent = false;
    else if (stage === 'discover' && (job.attention || job.stage === 'verification' || job.stage === 'interrupted')) job.resumeCurrent = true;
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
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再打开检索页面');
    if (job.status !== 'needs_attention' || !['discover', 'fulltext'].includes(job.resumeStage)) throw new Error('当前任务没有等待处理的检索或全文页面');
    if ([...this.jobs.values()].some(item => item.status === 'running' || item.browserOpening)) throw new Error('检索浏览器正在使用，请稍后再打开');
    const attention = sourceAttention(job.attention);
    const source = attention && job.config?.sources?.includes(attention.source) ? attention.source : null;
    const fulltext = job.resumeStage === 'fulltext';
    if (!fulltext && !source) throw new Error('缺少当前等待来源，请先继续任务以重新检查');
    job.browserOpening = true;
    try {
      const python = fulltext ? await this.prepareOffline(job) : job.python || await this.prepare(job, () => {});
      if (job.status !== 'needs_attention') throw new Error('任务状态已变化，请刷新后再操作');
      if (fulltext) {
        const result = await this.openFulltext(job, python);
        if (!result || result.opened !== true) throw new Error('全文任务页打开失败');
        return { opened: true, stage: 'fulltext', label: '原全文任务页' };
      }
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
    const frozenConfig = saved.config || loadJsonFile(path.join(dir, 'run_config.json'));
    saved.deletedAt = saved.deletedAt || null;
    saved.deferredSources = checkpointDeferredSources(dir, frozenConfig);
    saved.deferredOnly = checkpointDeferredOnly(dir, frozenConfig);
    saved.processingBasis = processingBasisFor(dir, frozenConfig);
    saved.executionOrder = executionOrder(frozenConfig, saved.deferredSources);
    const interrupted = saved.status === 'running';
    if (saved.status === 'running') {
      saved.status = 'failed'; saved.stage = 'interrupted';
      saved.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      saved.files = scanDeliverables(dir);
      const detected = detectStagedArtifacts(dir);
      saved.stages = detected.stages;
      saved.resumeStage = detected.resumeStage;
      const config = saved.config || loadJsonFile(path.join(dir, 'run_config.json'));
      if (config?.searchMode === 'formal' && config.stopMode === 'end' && saved.resumeStage === 'discover') {
        saved.status = 'needs_attention';
        saved.error = null;
        saved.attention = null;
        saved.message = '本地服务已重启，检索已暂停；已有分页结果保留，尚未确认末页。请点击“检查并继续”恢复原任务。';
      }
    }
    restoreCnkiRetryScope(saved, interrupted);
    saved.canReviewFulltext = fulltextReviewEligible(saved, dir);
    saved.cnkiRetryItems = cnkiRetryItems(saved, dir);
    return saved;
  }

  //: GET /api/literature/jobs（§21.2.3）：按 job.json mtime 倒序，损坏记录跳过。
  list(limit, options = {}) {
    const size = Math.min(50, Math.max(1, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : 20));
    if (!fs.existsSync(this.base)) return [];
    const entries = [];
    for (const name of fs.readdirSync(this.base)) {
      if (!ID.test(name)) continue;
      const file = path.join(this.base, name, 'job.json');
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      let saved = loadJsonFile(file);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      saved.deletedAt = saved.deletedAt || null;
      if (saved.deletedAt && options.includeDeleted !== true) continue;
      if (!this.jobs.has(name) && saved.status === 'running' && hasCnkiRetryScope(saved)) saved = this.snapshot(name);
      const config = saved.config || loadJsonFile(path.join(this.base, name, 'run_config.json'));
      saved.deferredSources = checkpointDeferredSources(path.join(this.base, name), config);
      saved.deferredOnly = checkpointDeferredOnly(path.join(this.base, name), config);
      saved.processingBasis = processingBasisFor(path.join(this.base, name), config);
      saved.executionOrder = executionOrder(config, saved.deferredSources);
      saved.canReviewFulltext = fulltextReviewEligible(saved, path.join(this.base, name));
      saved.cnkiRetryItems = cnkiRetryItems(saved, path.join(this.base, name));
      entries.push({ mtime: stat.mtimeMs, job: saved });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, size).map(entry => entry.job);
  }

  setDeleted(id, deleted) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const dir = path.join(this.base, id), file = path.join(dir, 'job.json');
    let saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    let live = this.jobs.get(id);
    if (live?.status === 'running' || live?.child || live?.browserOpening) {
      throw new Error('任务正在运行或打开检索页面，请先停止后再删除或恢复');
    }
    if (!live && saved.status === 'running') live = this.loadPersisted(id);
    if (live && saved.status === 'running' && live.status !== 'running') saved = { ...saved, ...this.public(live) };
    const deletedAt = deleted ? saved.deletedAt || new Date().toISOString() : null;
    if ((saved.deletedAt || null) !== deletedAt) {
      const temporary = path.join(dir, `job.json.tmp-${process.pid}-${Date.now()}`);
      try {
        fs.writeFileSync(temporary, JSON.stringify({ ...saved, deletedAt }, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch (_) {} }
      }
    }
    if (live) live.deletedAt = deletedAt;
    return this.snapshot(id);
  }

  deleteJob(id) { return this.setDeleted(id, true); }

  restoreJob(id) { return this.setDeleted(id, false); }

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
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再操作');
    if (!job || !['running', 'needs_attention'].includes(job.status)) throw new Error('检索任务未在运行');
    job.status = 'cancelled';
    if (job.child) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    const discover = !job.activeStage || job.activeStage === 'discover';
    this.update(job, 'cancelled', discover ? '检索已停止；持久浏览器保持打开' : '任务已停止；已完成的阶段产物保留');
    return this.public(job);
  }
}

module.exports = { LiteratureConnector, STAGES, DELIVERABLE_PATTERNS, __internals: { preparePython, requirementsHash, detectStagedArtifacts, extractionCoverage, resolveLimits } };
