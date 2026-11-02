'use strict';

// Local evidence and decisions only. This module has no network/model client.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readJson, writeJson, hashFile } = require('./source-transfer');
const { compile: compileProfessionalRules } = require('../js/download-professional-rules');
const ID = /^[0-9a-f-]{36}$/;
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function stableEvidence(value, reportId) {
  let text = JSON.stringify(value).replace(/verification-[a-f0-9]{12}-/g, 'verification-');
  if (reportId) text = text.split(reportId).join('REPORT');
  return JSON.parse(text);
}
function canonicalName(name) { return typeof name === 'string' && name.length > 0 && name.length <= 500 && !/[\\:\x00-\x1f]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)); }

function inside(base, file, exists = true) {
  const root = path.resolve(base), target = path.resolve(file), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('核验路径不在本任务目录内');
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('核验目录不能是符号链接');
  let at = root;
  for (const part of relative.split(path.sep)) {
    at = path.join(at, part);
    if (!fs.existsSync(at)) { if (exists) throw new Error('核验文件不存在：' + path.basename(target)); break; }
    if (fs.lstatSync(at).isSymbolicLink()) throw new Error('核验不接受符号链接文件或目录');
  }
  return target;
}
function scopeOf(job) {
  if (job.kind === 'faostat-tm') {
    const filters = Object.fromEntries(Object.entries(job.config?.filters || {}).filter(([, values]) => values?.length)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]));
    return { kind: job.kind, dataset: job.config?.dataset, filters };
  }
  return { kind: 'files', sources: (job.sources || []).map(source => source.url).sort(), rulesSha256: digest(job.rules || '') };
}
function unresolved(issue) { return !issue.resolution || !['accept', 'reject'].includes(issue.resolution.decision); }
function impactText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '本批数据';
  const labels = { revised: '历史修订', removed: '记录减少', added: '新增记录', unitChanges: '单位变化', keys: '重复记录键', currentRows: '本批涉及记录', baselineRows: '旧版涉及记录', years: '涉及年份', file: '涉及文件', currentFormats: '本批格式', baselineFormats: '旧版格式', addedColumns: '新增字段', removedColumns: '缺失字段' };
  const parts = Object.entries(value).filter(([key]) => labels[key]).map(([key, item]) => labels[key] + '：' + (Array.isArray(item) ? item.join('、') : item));
  return parts.length ? parts.join('；') : '本批数据范围或结构存在待确认的变化，具体位置见依据。';
}
function statusOf(issues) {
  if (issues.some(issue => issue.resolution?.decision === 'reject')) return 'rejected';
  if (issues.some(issue => issue.severity === 'error' && unresolved(issue))) return 'blocked';
  if (issues.some(issue => issue.decisionRequired && unresolved(issue))) return 'needs_decision';
  return 'ready';
}

class DownloadAcceptance {
  constructor(downloads) { this.downloads = downloads; this.bridge = downloads.bridge; this.pending = new Map(); this.children = new Set(); this.childByJob = new Map(); this.cancelled = new Set(); }
  engineVersion() { return digest(this.run.toString() + ['download_verification.py', 'download_professional_rules.py', '../js/download-professional-rules.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n')); }
  jobDirectory(job) { return inside(this.bridge.root, this.downloads.location(job.sessionId, job.id)); }
  list(sessionId) {
    const output = inside(this.bridge.root, path.join(this.bridge.session(sessionId), 'output'));
    return fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && ID.test(entry.name)).map(entry => {
      const job = readJson(inside(output, path.join(output, entry.name, 'run-state.json'), false));
      return job?.sourceJob && job.id === entry.name && job.sessionId === sessionId ? job : null;
    }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  get(sessionId, id) {
    const job = this.downloads.load(sessionId, id), directory = this.jobDirectory(job);
    const stored = job.verification?.reportName;
    if (!stored) return { jobId: id, status: 'not_checked', checks: [], issues: [], artifacts: [], summary: {} };
    const report = readJson(inside(directory, path.join(directory, stored)));
    if (!report || report.jobId !== id || report.sessionId !== sessionId) throw new Error('核验记录损坏，请对现有文件重新核验');
    if (report.status === 'checking' && !this.pending.has(id)) return { ...report, status: 'not_checked', message: '上次本地核验已中断，请重新核验已有文件；不会重新下载。' };
    return report;
  }
  save(job, report, relative) {
    const directory = this.jobDirectory(job), reportName = relative || job.verification?.reportName;
    writeJson(inside(directory, path.join(directory, reportName), false), report);
    job.verification = { id: report.id, status: report.status, summary: report.summary, baseline: report.baseline, reportName };
    this.downloads.save(job);
  }
  legacyRecords(sessionId) {
    const output = inside(this.bridge.root, path.join(this.bridge.session(sessionId), 'output'));
    return fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && ID.test(entry.name)).map(entry => {
      const name = entry.name + '/download-report.json', file = inside(output, path.join(output, name), false);
      const record = readJson(file); return record?.ok && record.storedName ? { ...record, reportName: name } : null;
    }).filter(Boolean);
  }
  adopt(sessionId, rules, names) {
    if (typeof rules !== 'string' || !rules.trim() || rules.length > 20000 || !Array.isArray(names) || !names.length || names.length > 5 || new Set(names).size !== names.length || names.some(name => !canonicalName(name))) throw new Error('请提供当前方案和本批已有文件清单');
    if (this.bridge.active(sessionId)) throw new Error('当前文件任务正在运行，请结束后核验');
    const jobs = this.list(sessionId), matching = jobs.find(job => job.legacy && job.rules === rules && digest(job.deliverables.map(file => file.storedName).sort()) === digest([...names].sort()));
    if (matching) return matching.id;
    const records = this.legacyRecords(sessionId), files = names.map(name => {
      const record = records.find(item => item.storedName === name);
      if (!record || record.rules !== rules || !/^[0-9a-f]{64}$/.test(record.sha256 || '')) throw new Error('已有文件缺少与当前方案一致的真实下载记录：' + name + '。原文件保留，请先核对来源和方案。');
      inside(this.bridge.root, this.bridge.download(sessionId, 'input', name));
      return { name: record.name || path.basename(name), storedName: name, group: 'input', size: record.size, sha256: record.sha256, finalUrl: record.finalUrl, sourceReport: record.reportName };
    });
    const id = randomUUID(), job = { sourceJob: true, legacy: true, id, sessionId, kind: 'files', rules, rulesSha256: digest(rules),
      sources: files.map(file => ({ url: file.finalUrl, name: file.name })), deliverables: files, status: 'completed', stage: 'completed',
      message: '已有下载文件已登记，等待本地核验；未重新下载', progress: {}, createdAt: now() };
    fs.mkdirSync(this.downloads.location(sessionId, id)); this.downloads.save(job);
    fs.writeFileSync(path.join(this.jobDirectory(job), 'approved-plan.md'), rules, { flag: 'wx' });
    return id;
  }
  chooseBaseline(job) {
    const past = this.list(job.sessionId).filter(item => item.id !== job.id && item.status === 'completed' && item.deliverables?.length && item.createdAt < job.createdAt);
    const compatible = past.filter(item => digest(scopeOf(item)) === digest(scopeOf(job)));
    const selected = compatible.find(item => item.acceptanceConfirmed) || compatible[0];
    return { job: selected || null, mode: selected ? 'comparable' : past.length ? 'incompatible' : 'first',
      reason: selected ? (selected.acceptanceConfirmed ? '与此前人工确认批次比较' : '与上次完成批次比较；其尚未人工验收，差异仅供核查') : past.length ? '历史批次的来源或筛选范围不同，未将不同范围误计为删除' : '首次获取，无同会话历史批次可比' };
  }
  files(job) {
    if (!Array.isArray(job.deliverables) || !job.deliverables.length || job.deliverables.length > 5) throw new Error('本批没有完整的可核验交付文件');
    return job.deliverables.map(file => {
      if (!canonicalName(file.storedName)) throw new Error('来源交付清单包含不规范文件名');
      inside(this.bridge.root, path.join(this.bridge.session(job.sessionId), 'input', file.storedName));
      return { ...file, path: inside(this.bridge.root, this.bridge.download(job.sessionId, 'input', file.storedName)) };
    });
  }
  async engine(request, file, runDirectory, jobId) {
    const requestFile = path.join(runDirectory, 'request.json'); writeJson(requestFile, request);
    const local = path.resolve(__dirname, '../.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    const python = this.downloads.options.python || (fs.existsSync(local) ? local : process.env.WORKBENCH_PYTHON || (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3'));
    await new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(__dirname, 'download_verification.py'), '--request', requestFile, '--output', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.children.add(child); this.childByJob.set(jobId, child); let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('本地核验超过处理时限，原文件保留；请分批核验')); }, 30 * 60 * 1000);
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4000); });
      child.once('error', error => { clearTimeout(timer); this.children.delete(child); this.childByJob.delete(jobId); reject(error); });
      child.once('exit', code => { clearTimeout(timer); this.children.delete(child); this.childByJob.delete(jobId); code === 0 ? resolve() : reject(new Error(stderr || '本地核验进程未完成')); });
    });
    const result = readJson(file); if (!result || result.schema !== 1 || !Array.isArray(result.issues)) throw new Error('核验引擎没有返回有效的检查证据');
    return result;
  }
  verify(sessionId, id, options = {}) {
    if (this.pending.has(id)) return this.pending.get(id);
    const job = options.job || this.downloads.load(sessionId, id);
    if (!options.internal && (this.bridge.active(sessionId) || this.downloads.running.size)) throw new Error('当前下载或文件任务正在运行，请结束后核验已有文件');
    const owned = !this.bridge.sourceBusy.has(sessionId);
    this.cancelled.delete(id);
    if (owned) this.bridge.sourceBusy.add(sessionId);
    const promise = this.run(job).finally(() => { this.pending.delete(id); if (owned) this.bridge.sourceBusy.delete(sessionId); });
    this.pending.set(id, promise); return promise;
  }
  async run(job) {
    const previous = job.verification?.reportName ? this.get(job.sessionId, job.id) : null;
    const id = randomUUID(), directory = this.jobDirectory(job), relative = 'verification/' + id + '/report.json';
    const runDirectory = inside(directory, path.join(directory, 'verification', id), false); fs.mkdirSync(runDirectory, { recursive: true });
    const artifact = name => job.id + '/verification/' + id + '/' + name;
    const engineVersion = this.engineVersion();
    const report = { schema: 1, id, engineVersion, previousReportId: previous?.id || null, jobId: job.id, sessionId: job.sessionId, createdAt: now(), rulesSha256: digest(job.rules), status: 'checking',
      summary: {}, baseline: {}, checks: [], issues: [], manifest: [], artifacts: [{ name: artifact('report.json'), label: '完整核验报告' }] };
    this.save(job, report, relative);
    const issue = (code, title, severity, impact, evidence, recommendation, attempts = []) => ({ id: digest(stableEvidence({ code, impact, evidence }, id)).slice(0, 20), code, title, severity,
      decisionRequired: severity === 'warning', canAccept: severity === 'warning', impact: impactText(impact),
      evidence: (Array.isArray(evidence) ? evidence : [evidence]).map(value => typeof value === 'string' ? { label: '核验依据', detail: value } : value && (value.label || value.detail) ? value : { label: '具体检查证据', detail: JSON.stringify(value, null, 2) }), recommendation, attempts });
    try {
      const professionalRules = compileProfessionalRules(job.rules);
      report.professionalRules = professionalRules;
      writeJson(path.join(runDirectory, 'professional-rules.json'), { ...professionalRules, rulesSha256: report.rulesSha256, note: '从本批冻结的已确认方案确定性读取；规则依据与原文保留，未改写原始数据。' });
      report.artifacts.push({ name: artifact('professional-rules.json'), label: '本批专业规则与方案依据' });
      if (job.status !== 'completed' && !(job.status === 'running' && job.stage === 'verification' && this.downloads.running.has(job.id))) report.issues.push(issue('incomplete_job', '本批下载尚未完整结束', 'error', '部分文件可能缺失，不能按全批交接', job.message || job.error || job.status, '保留已取得文件；核对失败记录后补取或调整方案。'));
      const selection = this.chooseBaseline(job), baseline = selection.job;
      report.baseline = { jobId: baseline?.id || null, label: baseline ? (baseline.catalog?.DateUpdate || '历史批次 ' + baseline.id.slice(0, 8)) : '无可比旧批次', createdAt: baseline?.createdAt || null, mode: selection.mode, reason: selection.reason };
      const currentFiles = this.files(job), baselineFiles = baseline ? this.files(baseline) : [];
      if (job.archive) {
        inside(this.bridge.root, path.join(this.bridge.session(job.sessionId), 'output', job.archive.name));
        const original = inside(this.bridge.root, this.bridge.download(job.sessionId, 'output', job.archive.name));
        if (fs.statSync(original).size !== job.archive.size || await hashFile(original) !== job.archive.sha256) throw new Error('保留的官方原包与下载校验记录不符');
        report.checks.push({ id: 'archive', label: '官方原包完整性', status: job.result?.zipCRCVerified ? 'passed' : 'partial', evidence: '原包实际大小及SHA-256与本次下载记录一致。' + (job.result?.zipCRCVerified ? '筛选记录包含ZIP CRC核对通过的证据。' : '尚无ZIP CRC完整核对证据。') });
      }
      const workDir = inside(this.bridge.root, path.join(this.bridge.session(job.sessionId), '.source-staging', job.id, 'verification', id), false); fs.mkdirSync(workDir, { recursive: true });
      const request = { current: { files: currentFiles, kind: job.kind, config: job.config, result: job.result, catalog: job.catalog, professionalRules },
        baseline: baseline ? { files: baselineFiles, kind: baseline.kind, config: baseline.config, result: baseline.result, catalog: baseline.catalog } : null, outputDir: runDirectory, workDir };
      if (this.cancelled.has(job.id)) throw new Error('本地核验已停止，原文件保留');
      const raw = await this.engine(request, path.join(runDirectory, 'engine.json'), runDirectory, job.id);
      if (this.cancelled.has(job.id)) throw new Error('本地核验已停止，原文件保留');
      report.profile = raw.profile; report.comparison = raw.comparison; report.limitations = raw.limitations || [];
      report.professionalChecks = raw.professionalChecks || [];
      for (const check of report.professionalChecks) report.checks.push({ id: 'professional_' + check.id, label: '专业规则：' + check.label,
        status: check.status === 'passed' ? 'passed' : 'partial', evidence: '已检查 ' + (check.checkedRows || 0) + ' 条；异常 ' + (check.failedRows || 0) + ' 条。' + (check.reason || '') });
      if (professionalRules.state === 'none') report.checks.push({ id: 'professional_none', label: '专业规则范围', status: 'info', evidence: '本方案明确无额外专业规则；依据：' + professionalRules.rationale });
      for (const file of currentFiles) {
        // The engine records actual hashes, and also checks expected hashes. Its
        // manifest is tied back to this immutable source-job delivery list.
        const actual = raw.profile?.current?.files?.find(item => item.path === file.path || item.name === file.name);
        if (!actual || actual.sha256 !== file.sha256 || actual.size !== file.size) report.issues.push(issue('integrity_' + file.storedName, '交付文件与下载记录不一致', 'error', file.name, '实际文件大小或SHA-256无法对应本批记录', '重新核验来源文件，必要时补取；不接受损坏文件。'));
        report.manifest.push({ name: file.storedName, size: file.size, sha256: file.sha256 });
      }
      report.checks.push({ id: 'files', label: '文件完整性与结构', status: raw.issues.some(item => item.severity === 'error') ? 'failed' : 'passed', evidence: '逐文件核对实际内容、大小、SHA-256、已支持格式的结构及记录数；未支持的解析会单列问题。' });
      report.checks.push({ id: 'scope', label: '来源与方案范围', status: job.kind === 'faostat-tm' ? (raw.issues.some(item => /scope|year|filter/.test(item.code) && item.severity === 'error') ? 'failed' : 'passed') : 'partial', evidence: job.kind === 'faostat-tm' ? '对照冻结方案的年份与官方代码条件扫描本批记录，保留官方名称/代码和实际单位证据。' : '下载来源与冻结方案绑定；普通文件的研究变量含义仍需来源适配器或一次明确确认。' });
      report.checks.push({ id: 'updates', label: '新旧批次差异', status: selection.mode === 'comparable' ? (raw.comparison?.comparable && !raw.comparison?.summary?.duplicateKeys ? 'passed' : 'partial') : 'info', evidence: selection.reason + '；比较状态：' + (raw.comparison?.status || '未完成') });
      for (const item of raw.issues) {
        const permittedWindow = item.code === 'coverage-reduced' && job.kind === 'faostat-tm' && job.config?.years?.every(year => raw.profile.current.years.includes(String(year)))
          && raw.comparison.coverage.missingYears.every(year => !job.config.years.includes(Number(year)));
        if (permittedWindow) { report.checks.push({ id: 'year_window', label: '已确认的年份窗口调整', status: 'info', evidence: '本次已审核年份均有记录；旧版其他年份未计作记录删除，也不重复要求确认范围。' }); continue; }
        const entry = issue(item.code, item.question || item.title || item.code, item.severity === 'error' ? 'error' : 'warning', item.affected || item.impact || '本批数据', item.evidence || [], item.recommendation || '查看证据后决定处理方式。', item.attempts || ['已读取本批实际文件并核对历史对比证据；未删除、插补或换算原值。']);
        if (item.ruleId) { entry.ruleId = item.ruleId; entry.decisionPrompt = '请决定是否接受本批例外并说明依据，或退回修订规则/文件后复核；接受例外不会将该规则改记为自动检查通过。'; }
        if (item.ruleId) {
          entry.evidence = [{ label: '已确认的规则依据', detail: String(item.evidence?.basis || '规则依据尚未明确') },
            { label: '本批方案中的原规则', detail: String(item.evidence?.sourceText || item.evidence?.reason || '见专业规则记录') },
            { label: '实际检查', detail: '规则 ' + item.ruleId + '；已检查 ' + (item.evidence?.checkedRows || 0) + ' 条；异常 ' + (item.evidence?.failedRows || 0) + ' 条；' + (item.evidence?.reason || '') }];
          for (const sample of (item.evidence?.samples || []).slice(0, 3)) entry.evidence.push({ label: '原文件定位示例', detail: (sample.file ? sample.file + (sample.line ? ' 第' + sample.line + '行' : '') + '：' : '') + JSON.stringify(sample.values || sample) });
        } else if (Array.isArray(item.evidence?.samples) && item.evidence.samples.some(sample => sample.type === 'revised' && sample.current && sample.baseline && Array.isArray(sample.changedColumns) || sample.type === 'removed' && sample.baseline)) {
          const examples = item.evidence.samples.filter(sample => sample.type === 'revised' && sample.current && sample.baseline && Array.isArray(sample.changedColumns) || sample.type === 'removed' && sample.baseline).slice(0, 3);
          const preview = value => String(value ?? '（无）').length > 120 ? String(value).slice(0, 120) + '…（完整值见差异依据）' : String(value ?? '（无）');
          entry.evidence = examples.map(sample => ({ label: sample.type === 'revised' ? '修订记录示例' : '减少记录示例', detail: sample.type === 'revised'
            ? `${sample.current.file} 第${sample.current.line}行，对照旧版第${sample.baseline.line}行：` + sample.changedColumns.map(column => `${column}：${preview(sample.baseline.values[column])} → ${preview(sample.current.values[column])}`).join('；')
            : `${sample.baseline.file} 旧版第${sample.baseline.line}行在共同覆盖范围内未找到对应记录；具体原值见完整差异依据。` }));
          entry.evidence.push({ label: '检查范围', detail: '统计来自完整扫描；这里仅列最多3个示例，全部变化和原始定位保存在差异依据中。' });
        }
        const linkedEvidence = item.evidence?.evidenceFiles || (item.evidence?.evidenceFile ? [item.evidence.evidenceFile] : []);
        for (const file of linkedEvidence) {
          const name = path.basename(typeof file === 'string' ? file : file.name || file.path || '');
          if (name && name !== '.') entry.evidence.push({ label: '逐条核查依据', detail: '包含本项检查的完整记录及原文件位置。', artifact: { name: artifact(name), label: item.ruleId ? '查看全部专业规则依据' : '查看完整差异依据' } });
        }
        if (item.requiresDecision === false && entry.severity !== 'error') { entry.decisionRequired = false; entry.canAccept = false; }
        report.issues.push(entry);
      }
      const limited = raw.profile?.current?.files?.filter(file => file.status === 'limited' || file.contentChecked === false && file.status !== 'failed') || [];
      if (limited.length) report.issues.push(issue('content_reading_limited', '部分格式尚未完成内容解析', 'warning', limited.map(file => file.name).join('、'), limited.map(file => ({ file: file.name, limitation: file.limitation || '仅核对基础文件完整性，尚未核对内部数据内容' })), '提供同源CSV/TSV后核验，或明确接受仅完成基础文件检查的交付；不能当作完整内容核验通过。'));
      if (selection.mode === 'incompatible') report.issues.push(issue('new_baseline', '本次来源或范围与历史批次不同', 'warning', '无法把不同范围直接作为同口径更新比较', selection.reason, '确认作为独立的新基线，或修订方案后重新核对。', ['已检查本会话历史下载批次；未混用其他项目数据。']));
      if (job.kind !== 'faostat-tm') {
        const scopeEvidence = JSON.stringify({ sources: job.sources, years: raw.profile?.current?.years || [], columns: raw.profile?.current?.columns || [] });
        const baselineReport = baseline?.acceptanceConfirmed && baseline.verification ? this.get(baseline.sessionId, baseline.id) : null;
        const inherited = baselineReport?.rulesSha256 === report.rulesSha256 && baselineReport?.issues?.find(item => item.code === 'scope_semantics' && item.resolution?.decision === 'accept' && item.evidence?.some(value => value.detail === scopeEvidence));
        if (!inherited) report.issues.push(issue('scope_semantics', '普通文件的业务范围需确认', 'warning', '来源和文件结构已核对，研究变量含义没有专用自动适配器', scopeEvidence, '根据显示的来源、字段与年份确认是否符合方案；无需逐行重查全部数据。'));
      }
      const details = raw.evidenceFiles || raw.comparison?.evidenceFiles || [];
      for (const value of details) {
        const name = typeof value === 'string' ? path.basename(value) : path.basename(value.name || value.path || '');
        if (!name || name === '.') continue;
        inside(runDirectory, path.join(runDirectory, name)); report.artifacts.push({ name: artifact(name), label: typeof value === 'object' && value.label || '逐条差异证据' });
      }
      report.artifacts.push({ name: artifact('engine.json'), label: '文件画像与比较明细' });
      report.summary = { ...(raw.comparison?.summary || {}), added: (raw.comparison?.summary?.added || 0) + (raw.comparison?.coverage?.addedYearRows || 0),
        professionalRules: professionalRules.rules.length, professionalPassed: report.professionalChecks.filter(check => check.status === 'passed').length, professionalPending: report.professionalChecks.filter(check => check.status !== 'passed').length,
        addedYears: raw.comparison?.coverage?.addedYears || [], missingYears: raw.comparison?.coverage?.missingYears || [],
        currentRows: raw.profile?.current?.rows ?? null, baselineRows: raw.profile?.baseline?.rows ?? null };
      report.checks.find(check => check.id === 'files').status = report.issues.some(item => item.severity === 'error' && /file|integrity|csv|structure/.test(item.code)) ? 'failed' : limited.length ? 'partial' : report.checks.find(check => check.id === 'files').status;
      report.evidenceFingerprint = digest(stableEvidence({ engineVersion, rules: report.rulesSha256, manifest: report.manifest, baseline: baseline ? { id: baseline.id, files: raw.profile?.baseline?.files?.map(file => ({ name: file.name, sha256: file.sha256, size: file.size })) } : null, issues: report.issues.map(item => ({ id: item.id, code: item.code, evidence: item.evidence })) }, id));
      if (previous?.evidenceFingerprint === report.evidenceFingerprint) for (const item of report.issues) {
        const old = previous.issues.find(prior => prior.id === item.id); if (old?.resolution) item.resolution = clone(old.resolution);
      }
    } catch (error) {
      report.issues.push(issue('verification_error', '本地核验未能完成', 'error', '本批文件暂不能按已核验结果交接', error.message, '原文件保留；处理文件或读取工具问题后点击“核验已有文件”。', ['已尝试读取本地已有文件；没有重新下载或修改数据。']));
    }
    report.status = statusOf(report.issues); report.completedAt = now();
    report.summary.openDecisions = report.issues.filter(item => item.decisionRequired && unresolved(item)).length;
    report.summary.blockingIssues = report.issues.filter(item => item.severity === 'error' && unresolved(item)).length;
    report.summary.professionalPending = report.issues.filter(item => item.ruleId && unresolved(item)).length;
    report.summary.professionalExceptions = report.issues.filter(item => item.ruleId && item.resolution?.decision === 'accept').length;
    this.save(job, report, relative); return report;
  }
  decide(sessionId, id, reportId, issueId, decision, note) {
    if (this.bridge.active(sessionId) || this.pending.has(id)) throw new Error('当前文件或核验任务正在运行');
    const job = this.downloads.load(sessionId, id), report = this.get(sessionId, id);
    if (report.id !== reportId || report.rulesSha256 !== digest(job.rules)) throw new Error('核验报告已变化，请刷新当前问题清单');
    if (!['accept', 'reject'].includes(decision) || typeof note !== 'string' || !note.trim() || note.length > 2000) throw new Error('请记录本次决定及简短依据');
    const target = report.issues.find(item => item.id === issueId);
    if (!target || decision === 'accept' && (!target.canAccept || target.severity === 'error')) throw new Error('该问题不能直接接受，请先修正后复核');
    const resolution = { decision, note: note.trim(), at: now(), actor: 'researcher' };
    target.resolution = resolution; (report.decisions || (report.decisions = [])).push({ issueId, ...resolution });
    report.status = statusOf(report.issues); report.summary.openDecisions = report.issues.filter(item => item.decisionRequired && unresolved(item)).length;
    report.summary.blockingIssues = report.issues.filter(item => item.severity === 'error' && unresolved(item)).length;
    report.summary.professionalPending = report.issues.filter(item => item.ruleId && unresolved(item)).length;
    report.summary.professionalExceptions = report.issues.filter(item => item.ruleId && item.resolution?.decision === 'accept').length;
    this.save(job, report); return report;
  }
  async importInput(targetId, sourceId, names, group, perform, expected = {}) {
    if (!Array.isArray(names) || !names.length || names.length > 5 || new Set(names).size !== names.length || names.some(name => !canonicalName(name))) throw new Error('请使用本批清单中的规范文件名确认交接');
    const jobs = this.list(sourceId), legacy = this.legacyRecords(sourceId), samePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const requested = names.map(name => {
      inside(this.bridge.root, path.join(this.bridge.session(sourceId), group, name));
      return { name, real: samePath(this.bridge.download(sourceId, group, name)) };
    });
    // Windows case and short-name aliases must not turn managed downloads into
    // apparently ordinary uploads. Classify by real paths before taking a gate.
    for (const record of jobs.flatMap(job => job.deliverables || []).concat(legacy)) {
      let actual;
      try { actual = samePath(this.bridge.download(sourceId, 'input', record.storedName)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (requested.some(item => item.real === actual && (group !== 'input' || item.name !== record.storedName))) throw new Error('请使用本批清单中的规范文件名确认交接，不能通过路径别名绕过核验');
    }
    for (const job of jobs) {
      const output = samePath(fs.realpathSync(this.jobDirectory(job))) + path.sep;
      if (requested.some(item => item.real.startsWith(output))) throw new Error('只允许交接本批已核验的交付文件，不能将下载原包或报告混作数据');
    }
    const matched = jobs.filter(job => job.deliverables?.some(file => names.includes(file.storedName)) || names.some(name => name.split('/')[0] === job.id));
    for (const name of names) {
      const prefix = name.split('/')[0];
      if (/^[0-9a-f-]{36}$/i.test(prefix) && !jobs.some(job => job.id === prefix) && (group === 'input' || fs.existsSync(path.join(this.bridge.session(sourceId), 'output', prefix, 'run-state.json')))) throw new Error('该批次的来源记录缺失或损坏，请先恢复记录并核验，不能绕过验收交接');
    }
    if (!matched.length) {
      if (legacy.some(record => names.includes(record.storedName))) throw new Error('旧下载文件尚未建立核验记录，请先点击“核验已有文件”；不会重新下载。');
      return perform();
    }
    if (matched.length !== 1) throw new Error('交接不能混入不同下载批次，请分别核验');
    const job = matched[0], report = this.get(sourceId, job.id);
    if (group !== 'input' || job.status !== 'completed' || names.length !== job.deliverables.length || !job.deliverables.every(file => names.includes(file.storedName))) throw new Error('只允许交接已完成且完整的本批交付清单，原包与历史文件不能混入');
    if (expected.sourceJobId && expected.sourceJobId !== job.id || expected.verificationReportId && expected.verificationReportId !== report.id) throw new Error('交接引用的核验报告已过期，请刷新后重新确认');
    if (report.status !== 'ready' || statusOf(report.issues) !== 'ready' || report.rulesSha256 !== digest(job.rules)) throw new Error('仍有未完成的核验或待决定问题，请先处理清单');
    if (report.engineVersion !== this.engineVersion()) throw new Error('核验规则引擎已更新，请对已有文件重新核验；不会重新下载');
    if (this.bridge.active(sourceId) || this.bridge.active(targetId)) throw new Error('文件任务正在进行，请结束后再交接');
    this.bridge.sourceBusy.add(sourceId); this.bridge.sourceBusy.add(targetId);
    let result;
    try {
      for (const file of job.deliverables) {
        const evidence = report.manifest.find(item => item.name === file.storedName);
        inside(this.bridge.root, path.join(this.bridge.session(sourceId), 'input', file.storedName));
        const original = inside(this.bridge.root, this.bridge.download(sourceId, 'input', file.storedName));
        if (!evidence || fs.statSync(original).size !== evidence.size || await hashFile(original) !== evidence.sha256) throw new Error('核验后文件发生变化，请重新核验：' + file.name);
      }
      // Release our own lease and copy synchronously in the same turn. Existing
      // bridge import checks must still reject any unrelated busy owner.
      this.bridge.sourceBusy.delete(sourceId); this.bridge.sourceBusy.delete(targetId);
      result = perform();
      job.acceptanceConfirmed = { reportId: report.id, at: now(), files: clone(report.manifest) }; this.downloads.save(job);
    } finally { this.bridge.sourceBusy.delete(sourceId); this.bridge.sourceBusy.delete(targetId); }
    return result;
  }
  cancel(id) { this.cancelled.add(id); this.childByJob.get(id)?.kill(); }
  close() { for (const [id, child] of this.childByJob) { this.cancelled.add(id); child.kill(); } }
}
module.exports = { DownloadAcceptance, scopeOf, inside, statusOf };
