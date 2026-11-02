'use strict';
// Owns frozen plans and independent local verification; never runs a cleaner.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { hashFile, readJson, writeJson } = require('./source-transfer');
const { inside } = require('./download-acceptance');
const ruleCompiler = require('../js/clean-verification-rules');
const executionPlan = require('../js/clean-execution-plan');
const ID = /^[a-f0-9-]{36}$/;
const DATA = /\.(csv|tsv|xlsx|xls|json|txt|parquet)$/i;
const STANDARD = /\.(pdf|docx|xlsx|xls|csv|tsv|txt|md|json)$/i;
const PLAN = 'approved-clean-plan.json';
const MANIFEST = 'cleaning-manifest.json';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = name => typeof name === 'string' && name.length > 0 && name.length <= 500 && !/[\\:\x00-\x1f]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
const unresolved = issue => !issue.resolution || !['accept', 'reject'].includes(issue.resolution.decision);
function stateOf(issues, manualChecks = []) {
  if (issues.some(item => item.resolution?.decision === 'reject') || manualChecks.some(item => item.resolution?.conclusion === 'rejected')) return 'rejected';
  if (issues.some(item => item.severity === 'error' && unresolved(item))) return 'blocked';
  if (issues.some(item => item.decisionRequired && unresolved(item))) return 'needs_decision';
  if (manualChecks.some(item => item.required !== false && (item.reason || item.resolution?.conclusion !== 'passed'))) return 'needs_manual';
  return 'ready';
}
function manualSpec(item) {
  return { id: item.id, label: item.label, method: item.method, condition: item.condition, required: item.required,
    basis: item.basis, sourceText: item.sourceText, ...(item.reason ? { reason: item.reason } : {}) };
}
function frozenManualRules(plan) {
  const adapter = executionPlan.prepare(plan.text);
  if (plan.executionText && (!adapter || plan.executionText !== adapter.executionText || plan.executionTextSha256 !== hash(adapter.executionText))) throw Error('执行技术副本与原规则不一致，请核对本次绑定记录');
  const compiled = ruleCompiler.compile(plan.executionText || plan.text).manualChecks || { state: 'none', rules: [] };
  if (compiled.state === 'needs_discussion' || compiled.rules.some(item => item.reason)) throw Error('人工核验标准尚待讨论确认，不能以人工签字代替补齐标准');
  if (plan.manualChecks && hash({ state: plan.manualChecks.state, rules: plan.manualChecks.rules?.map(manualSpec) }) !== hash({ state: compiled.state, rules: compiled.rules.map(manualSpec) })) throw Error('人工核验标准的冻结版本已变化，请先核对当前方案');
  for (const standard of plan.standardFiles || []) {
    if (standard.group !== 'reference' || !canonical(standard.name) || !STANDARD.test(standard.name) || plan.inputFiles.some(item => item.name === standard.name) || !plan.text.includes(standard.name)
      || !compiled.rules.some(item => [item.basis, item.sourceText].some(text => typeof text === 'string' && text.includes(standard.name)))) throw Error('标准原件尚未落实为本次明确人工核验项：' + standard.name);
  }
  return compiled.rules.map(manualSpec);
}
function refreshSummary(report) {
  const manual = report.manualChecks || [];
  report.status = stateOf(report.issues, manual);
  report.summary.openDecisions = report.issues.filter(item => item.decisionRequired && unresolved(item)).length;
  report.summary.blockingIssues = report.issues.filter(item => item.severity === 'error' && unresolved(item)).length;
  report.summary.acceptedExceptions = report.issues.filter(item => item.resolution?.decision === 'accept').length;
  report.summary.manualTotal = manual.length;
  report.summary.manualRequired = manual.filter(item => item.required !== false).length;
  report.summary.manualPassed = manual.filter(item => item.resolution?.conclusion === 'passed').length;
  report.summary.manualPending = manual.filter(item => !item.resolution).length;
  report.summary.manualRequiredPending = manual.filter(item => item.required !== false && item.resolution?.conclusion !== 'passed').length;
  report.summary.manualRejected = manual.filter(item => item.resolution?.conclusion === 'rejected').length;
  report.summary.manualNeedsEvidence = manual.filter(item => item.resolution?.conclusion === 'needs_evidence').length;
}
function stable(value, reportId) { return JSON.parse(JSON.stringify(value).split(reportId).join('REPORT').replace(/verification-[a-f0-9]{12}-/g, 'verification-')); }
function problem(code, title, detail, severity = 'error') {
  return { code, title, severity, impact: '本次清洗结果', evidence: [{ label: '实际核对依据', detail }], recommendation: '保留原文件和结果；补齐真实依据或修正受影响部分后重新核验。', attempts: ['已检查本次本地材料；未运行或重跑清洗。'] };
}

class CleanAcceptance {
  constructor(bridge, options = {}) { this.bridge = bridge; this.options = options; this.pending = new Map(); this.children = new Map(); }
  records(session) { return inside(this.bridge.root, path.join(this.bridge.session(session), '.clean-runs'), false); }
  recordFile(session, run) { if (!ID.test(run || '')) throw Error('无效清洗运行编号'); return inside(this.bridge.root, path.join(this.records(session), run + '.json'), false); }
  location(session, run, exists = true) { if (!ID.test(run || '')) throw Error('无效清洗运行编号'); return inside(this.bridge.root, path.join(this.bridge.session(session), 'output', run), exists); }
  legacyDataExists(session, run) {
    const directory = this.location(session, run, false);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return false;
    return fs.readdirSync(directory, { withFileTypes: true }).some(file => file.isFile() && !file.isSymbolicLink()
      && DATA.test(file.name) && !/plan|manifest|report/i.test(file.name));
  }
  save(record) { fs.mkdirSync(this.records(record.sessionId), { recursive: true }); writeJson(this.recordFile(record.sessionId, record.id), record); }
  load(session, run) {
    const record = readJson(this.recordFile(session, run));
    if (!record || record.sessionId !== session || record.id !== run || record.moduleType !== 'clean-data') throw Error('本次结果缺少冻结的清洗方案和输入记录，原文件保留；不能补造历史核验依据。');
    return record;
  }
  runs(session) {
    const records = this.records(session), values = [], registered = new Set();
    if (fs.existsSync(records)) for (const file of fs.readdirSync(records)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      registered.add(file.slice(0, -5));
      let record;
      try { record = this.load(session, file.slice(0, -5)); }
      catch (error) { values.push({ id: file.slice(0, -5), status: 'record_error', createdAt: fs.statSync(path.join(records, file)).mtime.toISOString(), planVersion: null, planText: null, message: error.message }); continue; }
      if (record.kind === 'discussion' || record.status === 'discussion' || record.status === 'legacy' && !record.plan && !this.legacyDataExists(session, record.id)) continue;
      const live = this.bridge.jobs.get(record.id);
      values.push({ id: record.id, status: record.status === 'running' && !live ? 'interrupted' : record.status,
        createdAt: record.createdAt, planVersion: record.plan?.version || null, planText: record.plan?.text || null, planSha256: record.plan?.sha256 || null,
        inputFiles: copy(record.plan?.inputFiles || []), executionAdapter: record.plan?.executionAdapter || null,
        standardFiles: copy(record.plan?.standardFiles || []), verification: record.verification, acceptanceConfirmed: record.acceptanceConfirmed || null });
    }
    const output = path.join(this.bridge.session(session), 'output');
    for (const file of fs.readdirSync(output, { withFileTypes: true })) {
      if (!file.isDirectory() || file.isSymbolicLink() || !ID.test(file.name) || registered.has(file.name)) continue;
      const directory = path.join(output, file.name);
      // Source acquisitions and plots are not retroactively called cleaning runs.
      if (fs.existsSync(path.join(directory, 'run-state.json')) || fs.existsSync(path.join(directory, 'approved-plot-plan.json'))) continue;
      if (!this.legacyDataExists(session, file.name)) continue;
      values.push({ id: file.name, status: 'legacy', createdAt: fs.statSync(directory).mtime.toISOString(), planText: null, planVersion: null });
    }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  ruleUpdateRecord(session) {
    const file = inside(this.bridge.root, path.join(this.bridge.session(session), '.clean-rule-updates.json'), false);
    if (!fs.existsSync(file)) return { file, value: { schema: 1, sessionId: session, updates: [] } };
    const value = readJson(file);
    if (!value || value.schema !== 1 || value.sessionId !== session || !Array.isArray(value.updates)) throw Error('规则同步记录损坏，原版本未覆盖');
    return { file, value };
  }
  async stageRuleUpdate(session, options = {}) {
    if (options.confirm !== true || typeof options.authorization !== 'string' || !options.authorization.trim() || options.authorization.length > 3000) throw Error('规则更新须保留研究者的明确授权');
    if (this.bridge.active(session)) throw Error('当前任务正在执行，不能变更执行规则');
    const sourceSession = options.sourceSessionId || session;
    const record = this.load(sourceSession, options.sourceRunId), beforeText = record.plan?.text;
    const original = executionPlan.prepare(beforeText);
    if (!original || original.binding || record.plan.inputFiles.length !== 1) throw Error('本入口仅解决原A规则的两项技术衔接，不改变其他方案');
    const input = record.plan.inputFiles[0];
    const binding = { sourceName: options.sourceName || input.name, inputName: options.inputName || input.name, sha256: input.sha256 };
    if (!canonical(binding.sourceName) || !canonical(binding.inputName) || binding.sourceName.includes('/') || binding.inputName.includes('/')) throw Error('输入绑定须明确使用当前任务中的规范文件名');
    const resolved = executionPlan.resolve(beforeText, binding);
    if (!resolved) throw Error('A规则与已冻结输入不能匹配，原版本未覆盖');
    for (const entry of [{ ...input, name: binding.inputName, group: 'input' }, { ...input, name: binding.sourceName, group: 'reference' }]) {
      const file = inside(this.bridge.root, path.join(this.bridge.session(session), entry.group, entry.name));
      if (await hashFile(file) !== entry.sha256) throw Error('原始数据或核验依据已变化，不能同步旧输入绑定：' + entry.name);
    }
    const adoptedStandards = [];
    for (const standard of record.plan.standardFiles || []) {
      const source = inside(this.bridge.root, path.join(this.bridge.session(sourceSession), 'reference', standard.name));
      if (await hashFile(source) !== standard.sha256) throw Error('原A规则的来源说明已变化，未迁移');
      const target = inside(this.bridge.root, path.join(this.bridge.session(session), 'reference', standard.name), false);
      const reused = fs.existsSync(target);
      if (!reused) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o444); }
      if (await hashFile(target) !== standard.sha256) throw Error('当前任务已有不同版本的来源说明，原文件未覆盖');
      adoptedStandards.push({ ...standard, sourceSessionId: sourceSession, reused });
    }
    const { file, value } = this.ruleUpdateRecord(session);
    const beforeSha256 = hash(beforeText), afterSha256 = hash(resolved.text);
    const prior = value.updates.find(item => item.beforeSha256 === beforeSha256 && item.afterSha256 === afterSha256);
    if (prior) return { update: copy(prior), reused: true };
    const update = { schema: 1, id: randomUUID(), sessionId: session, sourceSessionId: sourceSession, sourceRunId: record.id, createdAt: now(), standardFiles: adoptedStandards,
      beforeText, afterText: resolved.text, beforeSha256, afterSha256, binding,
      authorization: options.authorization.trim(), scope: '仅解决输入副本/版本绑定与异常处置两项技术衔接；不更改科学规则，不代签人工核验', acknowledgements: [] };
    value.updates.push(update); writeJson(file, value);
    return { update: copy(update), reused: false };
  }
  async ruleUpdate(session) {
    const { value } = this.ruleUpdateRecord(session), update = value.updates.at(-1);
    if (!update) return { update: null };
    const resolved = executionPlan.resolve(update.beforeText, update.binding);
    if (!resolved || resolved.text !== update.afterText || hash(update.beforeText) !== update.beforeSha256 || hash(update.afterText) !== update.afterSha256) throw Error('规则同步内容与授权更新不一致，原版本未覆盖');
    for (const group of ['input', 'reference']) {
      const name = group === 'input' ? update.binding.inputName : update.binding.sourceName;
      const file = inside(this.bridge.root, path.join(this.bridge.session(session), group, name));
      if (await hashFile(file) !== update.binding.sha256) throw Error('当前输入已变化，未应用旧的规则更新');
    }
    for (const standard of update.standardFiles || []) {
      const file = inside(this.bridge.root, path.join(this.bridge.session(session), 'reference', standard.name));
      if (await hashFile(file) !== standard.sha256) throw Error('当前来源说明已变化，未应用旧的规则更新');
    }
    return { update: copy(update) };
  }
  acknowledgeRuleUpdate(session, options = {}) {
    const { file, value } = this.ruleUpdateRecord(session), update = value.updates.find(item => item.id === options.updateId);
    if (!update || options.afterSha256 !== update.afterSha256 || !Number.isSafeInteger(options.version) || options.version < 2
      || typeof options.moduleId !== 'string' || !options.moduleId || options.moduleId.length > 200
      || typeof options.projectId !== 'string' || !options.projectId || options.projectId.length > 200) throw Error('规则同步回执与本次更新不匹配');
    const existing = update.acknowledgements.find(item => item.moduleId === options.moduleId && item.projectId === options.projectId && item.version === options.version);
    if (!existing) { update.acknowledgements.push({ moduleId: options.moduleId, projectId: options.projectId, version: options.version, afterSha256: options.afterSha256, at: now(), kind: 'browser-saved-version' }); writeJson(file, value); }
    return { acknowledged: true, updateId: update.id, version: options.version };
  }
  async bindInput(session, names, options = {}) {
    if (options.confirm !== true) throw Error('请明确确认将所选参考原件用作本次清洗输入');
    if (!Array.isArray(names) || !names.length || names.length > 30 || new Set(names).size !== names.length
      || names.some(name => !canonical(name) || name.includes('/') || !DATA.test(name))) throw Error('请明确选择当前任务中规范的数据原件，不自动扫描全部附件');
    const directory = inside(this.bridge.root, this.bridge.session(session));
    if (this.bridge.active(session)) throw Error('当前文件任务正在运行，不能变更清洗输入');
    this.bridge.sourceBusy.add(session);
    const created = [];
    try {
      const allFiles = this.bridge.files(session), inputs = allFiles.filter(file => file.group === 'input');
      const sources = [];
      for (const name of names) {
        if (!allFiles.some(file => file.group === 'reference' && file.name === name)) throw Error('所选数据原件不在当前任务的参考附件中：' + name);
        const file = inside(this.bridge.root, path.join(directory, 'reference', name));
        const stat = fs.statSync(file);
        if (!stat.isFile() || !stat.size || stat.size > 2 * 1024 ** 3) throw Error('清洗输入须为非空、最多2GiB的普通数据文件：' + name);
        sources.push({ name, file, size: stat.size, sha256: await hashFile(file) });
      }
      const knownInputs = [];
      for (const input of inputs) {
        if (!canonical(input.name) || !DATA.test(input.name)) continue;
        const file = inside(this.bridge.root, path.join(directory, 'input', input.name));
        const stat = fs.statSync(file);
        if (stat.isFile()) knownInputs.push({ name: input.name, file, size: stat.size });
      }
      const bindings = [];
      for (const source of sources) {
        const sameName = knownInputs.find(input => input.name === source.name);
        if (sameName && (sameName.size !== source.size || (sameName.sha256 ||= await hashFile(sameName.file)) !== source.sha256)) throw Error('清洗输入已有同名不同内容文件，原文件均保留，请明确使用版本：' + source.name);
        let target = sameName;
        if (!target) for (const input of knownInputs) {
          if (input.size === source.size && path.extname(input.name).toLowerCase() === path.extname(source.name).toLowerCase()
            && (input.sha256 ||= await hashFile(input.file)) === source.sha256) { target = input; break; }
        }
        const reused = !!target;
        if (!target) {
          const file = inside(this.bridge.root, path.join(directory, 'input', source.name), false);
          fs.copyFileSync(source.file, file, fs.constants.COPYFILE_EXCL);
          created.push(file);
          fs.chmodSync(file, 0o444);
          target = { name: source.name, file, size: source.size, sha256: await hashFile(file) };
          knownInputs.push(target);
        }
        if (target.sha256 !== source.sha256 || await hashFile(source.file) !== source.sha256) throw Error('复制期间原件内容发生变化，未采用新输入，请重新核对：' + source.name);
        bindings.push({ sourceGroup: 'reference', sourceName: source.name, inputName: target.name, size: source.size, sha256: source.sha256, reused });
      }
      const recordPath = inside(this.bridge.root, path.join(directory, '.clean-input-bindings.json'), false);
      const previous = readJson(recordPath);
      if (fs.existsSync(recordPath) && (!previous || previous.schema !== 1 || previous.sessionId !== session || !Array.isArray(previous.history))) throw Error('原有清洗输入绑定记录无效，未覆盖原记录');
      const record = { schema: 1, sessionId: session, history: [...(previous?.history || []), { at: now(), bindings }] };
      const temporary = inside(this.bridge.root, path.join(directory, '.clean-input-bindings-' + randomUUID() + '.tmp'), false);
      try { fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { flag: 'wx' }); fs.renameSync(temporary, recordPath); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return { sessionId: session, inputNames: [...new Set(bindings.map(item => item.inputName))], boundSources: bindings.map(item => item.sourceName),
        sourceToInput: Object.fromEntries(bindings.map(item => [item.sourceName, item.inputName])), bindings, files: this.bridge.files(session) };
    } catch (error) {
      for (const file of created) { fs.chmodSync(file, 0o644); fs.unlinkSync(file); }
      throw error;
    } finally { this.bridge.sourceBusy.delete(session); }
  }
  async freeze(session, value) {
    if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20000 || !Number.isSafeInteger(value.version) || value.version < 1) throw Error('请先确认清洗方案及核验规则');
    if (!Array.isArray(value.inputNames) || !value.inputNames.length || value.inputNames.length > 30 || new Set(value.inputNames).size !== value.inputNames.length) throw Error('请明确本次使用的原始文件，不自动混入历史输入');
    const standardNames = value.standardNames === undefined ? [] : value.standardNames;
    if (!Array.isArray(standardNames) || standardNames.length > 30 || new Set(standardNames).size !== standardNames.length) throw Error('请明确本次采用的标准原件，不自动混入历史附件');
    const adapted = executionPlan.prepare(value.text);
    const compiled = ruleCompiler.compile(adapted?.executionText || value.text), manual = compiled.manualChecks;
    if (manual?.state === 'needs_discussion' || manual?.rules?.some(item => item.reason)) throw Error('人工核验标准尚未明确，请先在同一份清洗方案中讨论并确认完整标准');
    for (const name of standardNames) {
      if (!canonical(name) || !STANDARD.test(name) || value.inputNames.includes(name)) throw Error('标准原件须独立保留，不能同时作为清洗数据：' + name);
      if (!value.text.includes(name) || !manual?.rules?.some(item => !item.reason && [item.basis, item.sourceText].some(text => typeof text === 'string' && text.includes(name)))) throw Error('标准原件尚未落实为明确人工核验项，请在同一方案的人工标准依据中引用完整文件名：' + name);
    }
    if (this.bridge.active(session)) throw Error('当前文件任务正在运行');
    this.bridge.sourceBusy.add(session);
    try {
      const allFiles = this.bridge.files(session), files = allFiles.filter(file => file.group === 'input');
      const inputFiles = [];
      for (const name of value.inputNames) {
        if (!canonical(name) || !DATA.test(name) || !files.some(file => file.name === name)) throw Error('本次清洗输入不是当前任务的规范数据文件：' + name);
        const source = inside(this.bridge.root, path.join(this.bridge.session(session), 'input', name));
        inputFiles.push({ name, size: fs.statSync(source).size, sha256: await hashFile(source) });
      }
      if (adapted?.binding && (inputFiles.length !== 1 || inputFiles[0].name !== adapted.binding.inputName || inputFiles[0].sha256 !== adapted.binding.sha256)) throw Error('A规则中的输入版本与实际文件不一致，原文件保留，未执行');
      const standardFiles = [];
      for (const name of standardNames) {
        if (!allFiles.some(file => file.group === 'reference' && file.name === name)) throw Error('本次标准原件不在当前任务的标准附件中：' + name);
        const source = inside(this.bridge.root, path.join(this.bridge.session(session), 'reference', name));
        if (!fs.statSync(source).isFile()) throw Error('标准原件不是可读取的文件：' + name);
        const standard = { name, group: 'reference', size: fs.statSync(source).size, sha256: await hashFile(source) };
        if (inputFiles.some(input => input.sha256 === standard.sha256)) throw Error('同一原件不能同时绑定为清洗输入和人工标准；原始数据可直接作为核验依据：' + name);
        standardFiles.push(standard);
      }
      return { schema: 1, text: value.text, version: value.version, sha256: hash(value.text), inputFiles, standardFiles, ...compiled,
        ...(adapted ? { executionAdapter: adapted.adapter, executionText: adapted.executionText, executionTextSha256: hash(adapted.executionText), executionLimitations: adapted.limitations || [], originalRulesPreserved: true } : {}), createdAt: now() };
    } finally { this.bridge.sourceBusy.delete(session); }
  }
  register(job) {
    this.save({ id: job.id, sessionId: job.sessionId, moduleType: 'clean-data', status: job.status, createdAt: job.createdAt, plan: job.cleanPlan, error: job.error || null });
    writeJson(path.join(this.location(job.sessionId, job.id), PLAN), job.cleanPlan);
  }
  registerDiscussion(job) {
    this.save({ id: job.id, sessionId: job.sessionId, moduleType: 'clean-data', kind: 'discussion', status: 'discussion', createdAt: job.createdAt || now(), plan: null });
  }
  finished(job) {
    const record = this.load(job.sessionId, job.id); record.status = job.status; record.error = job.error || null; record.model = job.model || null; record.finishedAt = now(); this.save(record);
    if (job.status === 'completed') void this.verify(job.sessionId, job.id, { internal: true }).catch(() => {});
  }
  guidance(plan) {
    return '本次是已确认的清洗执行。唯一冻结方案及输入SHA见本次输出目录的 ' + PLAN + '。仅处理其中inputFiles列出的文件，逐项遵守方案，不读入历史批次。原始输入只读，结果与代码保留在本次输出目录。\n'
      + (plan.executionText ? '本次保留原规则全文text及其摘要；executionText只是同一规则的程序可读表达，不是新科学方案。输入文件已绑定，原稿中输入副本与版本绑定事项已由inputFiles落实；遇解析或冲突按保留原文、写入错误位置与报告、停止受影响处理执行，不再反复索要同一技术确认。本次只清洗核验导出，不进行换算或增加数据列；原13字段、80条记录、顺序及每个原始字段文本全部保留。H1-H3继续保留为人工核验项，准备证据但不代签，不因签认尚未发生而停止清洗和文件交付。另交付field-dictionary.csv、row-mapping.csv、check-report.json、environment.json与README.txt，代码实际运行后交付。\n' : '')
      + 'standardFiles仅是已采用的标准原件参考，须只读保留，不能当作数据输入或结果，也不读取未冻结参考附件。平台仅保存标准原件哈希，不会据附件存在自动声称理解或检查通过。人工标准需准备实际核验依据与文件/记录/页节位置；不得代填人工结论或生成“人工已通过”。只有研究者在界面真实操作后，平台人工核验接口才记录结论。\n'
      + '实际完成后必须写 cleaning-manifest.json（不能伪造检查通过）：{"schema":1,"planSha256":"' + plan.sha256 + '","outputs":[{"name":"cleaned.csv","role":"cleaned"},{"name":"pending.csv","role":"pending"}],"lineage":"row-lineage.jsonl"}。仅列实际生成的结果和待处理数据（最多5个主结果、10个文件），不把代码、报告或原始文件副本当数据。\n'
      + 'row-lineage.jsonl每行是一个真实对应关系：{"sources":[{"file":"冻结inputFiles中的完整name","record":1}],"targets":[{"file":"cleaned.csv","record":1}],"action":"keep","ruleIds":[],"reason":"依据"}。record为去掉表头后的CSV逻辑记录，从1开始。所有原始记录必须恰有一个去向，全部结果/待处理记录必须有来源；合并用同一事件的多sources，拆分用多targets，不强求前后行数相等。action允许keep、transform、pending、exclude、duplicate、merge、split；exclude无targets要给确认规则与依据；duplicate无targets需额外retainedSource:{file,record}指向保留来源，不任意删除同值多次观测。字段/单位转换保留原值及规则依据。\n'
      + '平台会独立读取实际输入输出、核对去向并复算支持的改值，无法表达或未定的方法列为待处理。不要将模型自述或自写检查通过报告当作已通过平台核验。不要填写事后猜造的来源引用。';
  }
  engineVersion() { return hash(['clean-acceptance.js', 'clean_verification.py', 'download_professional_rules.py', '../js/clean-verification-rules.js', '../js/clean-execution-plan.js', '../js/download-professional-rules.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n')); }
  get(session, run) {
    let record; try { record = this.load(session, run); } catch (error) { if (fs.existsSync(this.recordFile(session, run))) throw error; this.location(session, run); return { schema: 1, runId: run, status: 'not_checked', summary: {}, checks: [], issues: [], manualChecks: [], artifacts: [], message: error.message }; }
    if (!record.verification) return { schema: 1, runId: run, status: 'not_checked', summary: {}, checks: [], issues: [], manualChecks: [], artifacts: [] };
    const report = readJson(inside(this.bridge.root, path.join(this.records(session), record.verification.name)));
    if (!report || report.runId !== run || report.sessionId !== session) throw Error('核验报告损坏，请核验已有结果');
    if (report.status === 'checking' && !this.pending.has(run)) return { ...report, status: 'not_checked', message: '上次核验已中断，原结果保留；请核验已有结果，不需重跑清洗。' };
    return report;
  }
  persistReport(record, report) {
    const relative = record.id + '/' + report.id + '.json', privatePath = inside(this.bridge.root, path.join(this.records(record.sessionId), relative), false);
    fs.mkdirSync(path.dirname(privatePath), { recursive: true }); writeJson(privatePath, report);
    writeJson(inside(this.bridge.root, path.join(this.location(record.sessionId, record.id), 'clean-verification', report.id, 'report.json'), false), report);
    record.verification = { id: report.id, name: relative, status: report.status, summary: report.summary }; this.save(record);
  }
  async engine(request, file, run, id) {
    const input = path.join(run, 'request.json'); writeJson(input, request);
    const local = path.resolve(__dirname, '../.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = this.options.python || (fs.existsSync(local) ? local : process.env.WORKBENCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
    await new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(__dirname, 'clean_verification.py'), '--request', input, '--output', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      this.children.set(id, child); let tail = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('本地核验超过处理时限，原结果保留；请按明确范围分批核验')); }, 30 * 60 * 1000);
      child.stderr.on('data', bytes => { tail = (tail + bytes.toString('utf8')).slice(-2000); });
      child.once('error', error => { clearTimeout(timer); this.children.delete(id); reject(error); });
      child.once('exit', code => { clearTimeout(timer); this.children.delete(id); code === 0 ? resolve() : reject(Error(tail || '清洗核验未完成')); });
    });
    const result = readJson(file); if (result?.schema !== 1 || !Array.isArray(result.issues) || !Array.isArray(result.checks)) throw Error('清洗核验器未返回有效证据'); return result;
  }
  verify(session, run, options = {}) {
    if (this.pending.has(run)) return this.pending.get(run);
    if (!options.internal && this.bridge.active(session)) throw Error('当前文件任务正在运行，请结束后核验已有结果');
    const owned = !this.bridge.sourceBusy.has(session); if (owned) this.bridge.sourceBusy.add(session);
    const promise = this.run(session, run).finally(() => { this.pending.delete(run); if (owned) this.bridge.sourceBusy.delete(session); });
    this.pending.set(run, promise); return promise;
  }
  async run(session, run) {
    let record; try { record = this.load(session, run); } catch (error) { if (fs.existsSync(this.recordFile(session, run))) throw error; record = { id: run, sessionId: session, moduleType: 'clean-data', status: 'legacy', createdAt: now(), plan: null }; }
    if (record.kind === 'discussion' || record.status === 'discussion') throw Error('本次仅为方案讨论，没有清洗结果可核验。请继续讨论规则，不需要重跑或确认清洗。');
    if (!record.plan && !this.legacyDataExists(session, run)) throw Error('本次没有可供核验的清洗结果；空讨论或仅有核验报告的目录不属于清洗运行，原记录保留。');
    const directory = this.location(session, run), id = randomUUID(), publicDir = path.join(directory, 'clean-verification', id);
    fs.mkdirSync(publicDir, { recursive: true });
    const previous = record.verification ? this.get(session, run) : null;
    const prefix = run + '/clean-verification/' + id + '/';
    const report = { schema: 1, id, sessionId: session, runId: run, createdAt: now(), status: 'checking', planSha256: record.plan?.sha256 || null, engineVersion: this.engineVersion(), checks: [], issues: [], manualChecks: [], standardFiles: copy(record.plan?.standardFiles || []), summary: {}, artifacts: [{ name: prefix + 'report.json', label: '完整清洗核验报告' }], files: [], cleanedNames: [] };
    this.persistReport(record, report);
    try {
      if (!record.plan) throw Error('旧结果缺少冻结输入、规则和逐条来源证据；原结果可继续查看下载。请补齐真实材料再核验，不能补造历史去向，也不会自动重跑清洗。');
      if (record.status !== 'completed') throw Error('本次清洗执行未完整成功，已生成文件保留：' + (record.error || record.status));
      if (hash(record.plan.text) !== record.plan.sha256) throw Error('冻结方案文本与摘要不一致，请核对当前方案');
      report.manualChecks = frozenManualRules(record.plan).map(item => ({ ...item, resolution: null, history: [] }));
      const snapshot = async (name, group, role) => {
        if (!canonical(name)) throw Error('核验材料包含不规范文件名');
        const file = inside(this.bridge.root, path.join(this.bridge.session(session), group, name));
        if (!fs.statSync(file).isFile()) throw Error('核验材料不是文件');
        const value = { name, group, size: fs.statSync(file).size, sha256: await hashFile(file), ...(role ? { role } : {}) };
        report.files.push(value); return { ...value, path: file };
      };
      const inputFiles = [];
      for (const input of record.plan.inputFiles) {
        const actual = await snapshot(input.name, 'input');
        if (actual.sha256 !== input.sha256 || actual.size !== input.size) throw Error('原始输入在确认后发生改变：' + input.name);
        inputFiles.push(actual);
      }
      for (const standard of record.plan.standardFiles || []) {
        const actual = await snapshot(standard.name, 'reference', 'standard');
        if (actual.sha256 !== standard.sha256 || actual.size !== standard.size) throw Error('标准原件在确认后发生改变：' + standard.name);
      }
      const approved = await snapshot(run + '/' + PLAN, 'output');
      if (hash(JSON.parse(fs.readFileSync(approved.path, 'utf8'))) !== hash(record.plan)) throw Error('公开方案文件与服务端冻结记录不一致');
      const manifestFile = await snapshot(run + '/' + MANIFEST, 'output');
      if (manifestFile.size > 1024 * 1024) throw Error('清洗材料清单超过1MiB');
      const manifest = readJson(manifestFile.path);
      if (manifest?.schema !== 1 || manifest.planSha256 !== record.plan.sha256 || !Array.isArray(manifest.outputs) || !manifest.outputs.length || manifest.outputs.length > 10 || manifest.outputs.filter(file => file.role === 'cleaned').length > 5 || !manifest.outputs.some(file => file.role === 'cleaned')) throw Error('实际结果清单缺失、未绑定本次方案，或尚未列出有效主结果');
      const names = new Set(); const outputs = [];
      for (const file of manifest.outputs) {
        if (!canonical(file.name) || !DATA.test(file.name) || !['cleaned', 'pending'].includes(file.role) || names.has(file.name) || /^(?:clean-verification|approved-clean-plan\.json|cleaning-manifest\.json)(?:\/|$)/i.test(file.name)) throw Error('结果清单含重复、非数据或不支持的材料条目');
        names.add(file.name);
        const actual = await snapshot(run + '/' + file.name, 'output', file.role); outputs.push({ ...actual, name: file.name });
        if (file.role === 'cleaned') report.cleanedNames.push(run + '/' + file.name);
      }
      if (!canonical(manifest.lineage) || !/\.jsonl$/i.test(manifest.lineage)) throw Error('缺少真实逐条去向JSONL清单');
      const lineage = await snapshot(run + '/' + manifest.lineage, 'output');
      const work = inside(this.bridge.root, path.join(this.bridge.session(session), '.clean-staging', run, id), false); fs.mkdirSync(work, { recursive: true });
      const raw = await this.engine({ schema: 1, plan: record.plan, inputs: inputFiles, outputs, lineagePath: lineage.path, outputDir: publicDir, workDir: work }, path.join(publicDir, 'engine.json'), work, run);
      report.checks = raw.checks; report.summary = raw.summary || {};
      report.issues = raw.issues.map(item => {
        const value = { ...item, id: hash(stable({ code: item.code, impact: item.impact, evidence: item.evidence }, id)).slice(0, 20), decisionRequired: item.severity !== 'error', canAccept: item.severity !== 'error' };
        value.evidence = (Array.isArray(item.evidence) ? item.evidence : [{ label: '实际核验依据', detail: JSON.stringify(item.evidence) }]).map(evidence => ({ ...evidence, ...(evidence.artifact?.name && canonical(evidence.artifact.name) ? { artifact: { ...evidence.artifact, name: prefix + evidence.artifact.name } } : {}) })); return value;
      });
      for (const file of raw.artifacts || []) {
        if (!canonical(file.name)) continue; inside(this.bridge.root, path.join(publicDir, file.name)); report.artifacts.push({ name: prefix + file.name, label: file.label || '独立核验依据' });
      }
      report.artifacts.push({ name: prefix + 'engine.json', label: '逐项核验明细' });
      report.evidenceFingerprint = hash(stable({ engine: report.engineVersion, plan: report.planSha256, files: report.files, manualChecks: report.manualChecks.map(manualSpec), issues: report.issues.map(issue => ({ id: issue.id, evidence: issue.evidence })) }, id));
      if (previous?.evidenceFingerprint === report.evidenceFingerprint) for (const issue of report.issues) {
        const prior = previous.issues.find(value => value.id === issue.id); if (prior?.resolution) issue.resolution = copy(prior.resolution);
      }
    } catch (error) {
      const issue = problem('clean-evidence-incomplete', '清洗结果尚不能完成独立核验', error.message);
      report.issues.push({ ...issue, id: hash(issue).slice(0, 20), decisionRequired: false, canAccept: false });
    }
    for (const check of report.manualChecks) {
      const prior = previous?.manualChecks?.find(value => value.id === check.id);
      if (prior?.history) check.history = copy(prior.history);
      // Past signatures remain visible, but are effective only for identical
      // standards, actual files, rules and verifier version.
      if (report.evidenceFingerprint && previous?.evidenceFingerprint === report.evidenceFingerprint && prior?.resolution && hash(manualSpec(prior)) === hash(manualSpec(check))) check.resolution = copy(prior.resolution);
    }
    report.completedAt = now(); refreshSummary(report);
    delete record.acceptanceConfirmed; this.persistReport(record, report); return report;
  }
  decide(session, run, reportId, issueId, decision, note) {
    if (this.bridge.active(session) || this.pending.has(run)) throw Error('当前文件或核验任务正在运行');
    const record = this.load(session, run), report = this.get(session, run);
    if (report.id !== reportId) throw Error('核验报告已变化，请刷新问题清单');
    if (!['accept', 'reject'].includes(decision) || typeof note !== 'string' || !note.trim() || note.length > 2000) throw Error('请填写本次决定及简短依据');
    const issue = report.issues.find(item => item.id === issueId);
    if (!issue || decision === 'accept' && (!issue.canAccept || issue.severity === 'error')) throw Error('此阻断错误不能强行接受，需修正后复核');
    issue.resolution = { decision, note: note.trim(), at: now(), actor: 'researcher' };
    (report.decisions || (report.decisions = [])).push({ issueId, ...issue.resolution });
    refreshSummary(report);
    delete record.acceptanceConfirmed; this.persistReport(record, report); return report;
  }
  async assertFresh(session, run, reportId, rulesText) {
    const record = this.load(session, run), report = this.get(session, run);
    if (record.status !== 'completed' || !record.plan || report.id !== reportId || report.engineVersion !== this.engineVersion() || report.planSha256 !== record.plan.sha256 || hash(record.plan.text) !== record.plan.sha256 || rulesText !== undefined && hash(rulesText) !== record.plan.sha256) throw Error('清洗方案、运行或核验版本已变化，请重新核验当前结果');
    if (!report.evidenceFingerprint || !report.files?.length || !report.cleanedNames?.length) throw Error('清洗结果尚无完整独立核验依据，请先核验已有结果');
    if (hash((report.manualChecks || []).map(manualSpec)) !== hash(frozenManualRules(record.plan))) throw Error('人工核验清单与当前冻结标准不一致，请重新核验');
    for (const expected of [...record.plan.inputFiles.map(item => ({ ...item, group: 'input' })), ...(record.plan.standardFiles || [])]) {
      if (!report.files.some(file => file.group === expected.group && file.name === expected.name && file.sha256 === expected.sha256 && file.size === expected.size)) throw Error('核验报告未包含本次完整输入及标准原件，请重新核验：' + expected.name);
    }
    for (const file of report.files) {
      if (!['input', 'output', 'reference'].includes(file.group) || !canonical(file.name)) throw Error('核验文件依据无效，请重新核验');
      const actual = inside(this.bridge.root, path.join(this.bridge.session(session), file.group, file.name));
      if (fs.statSync(actual).size !== file.size || await hashFile(actual) !== file.sha256) throw Error('核验后文件或逐条依据发生变化，请重新核验：' + file.name);
    }
    return { record, report };
  }
  async manualCheck(session, run, reportId, checkId, conclusion, note, evidence, reviewer, options = {}) {
    if (this.bridge.active(session) || this.pending.has(run)) throw Error('当前文件或核验任务正在运行');
    if (!['passed', 'rejected', 'needs_evidence'].includes(conclusion) || typeof note !== 'string' || !note.trim() || note.length > 2000) throw Error('请选择人工核验结论并填写简短说明');
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) throw Error('请明确记录本次人工核验人');
    if (typeof evidence !== 'string' || evidence.length > 4000 || conclusion === 'passed' && !evidence.trim()) throw Error('人工核验通过须填写核验依据的位置；退回或待补证据可暂留空');
    if (!options || typeof options.rulesText !== 'string' || !options.rulesText.trim()) throw Error('请提供当前显示的已确认清洗方案，以绑定本次人工核验');
    if (!Array.isArray(options.standardNames) || options.standardNames.length > 30 || new Set(options.standardNames).size !== options.standardNames.length || options.standardNames.some(name => !canonical(name))) throw Error('请提供当前采用的完整标准原件清单，没有附件时须明确为空清单');
    this.bridge.sourceBusy.add(session);
    try {
      const { record, report } = await this.assertFresh(session, run, reportId, options.rulesText);
      if (hash([...options.standardNames].sort()) !== hash((record.plan.standardFiles || []).map(file => file.name).sort())) throw Error('当前采用的标准原件清单已变化，请先核对同一方案后重新核验');
      const check = (report.manualChecks || []).find(item => item.id === checkId);
      if (!check) throw Error('人工核验项已变化，请刷新当前清单');
      if (conclusion === 'passed' && check.reason) throw Error('人工标准尚待明确，请先完善方案，不能用通过结论代替标准');
      check.resolution = { conclusion, note: note.trim(), evidence: evidence.trim(), reviewer: reviewer.trim(), at: now(), actor: 'researcher' };
      (check.history || (check.history = [])).push({ ...copy(check.resolution), reportId, evidenceFingerprint: report.evidenceFingerprint, rule: manualSpec(check) });
      refreshSummary(report); delete record.acceptanceConfirmed;
      this.persistReport(record, report); return report;
    } finally { this.bridge.sourceBusy.delete(session); }
  }
  async validate(session, run, reportId, rulesText) {
    const result = await this.assertFresh(session, run, reportId, rulesText), { report } = result;
    if (report.status !== 'ready' || stateOf(report.issues, report.manualChecks || []) !== 'ready') throw Error('清洗仍有阻断、未决定问题或必需人工核验未通过，暂不能交给计算');
    return result;
  }
  async confirm(session, run, reportId, rulesText) {
    if (typeof rulesText !== 'string' || !rulesText.trim()) throw Error('请提供当前已确认清洗方案以核对版本');
    if (this.bridge.active(session)) throw Error('当前文件任务正在运行'); this.bridge.sourceBusy.add(session);
    try {
      const { record, report } = await this.validate(session, run, reportId, rulesText);
      record.acceptanceConfirmed = { runId: run, reportId, planSha256: report.planSha256, at: now(), files: copy(report.files) }; this.save(record);
      return { confirmed: true, runId: run, reportId, planSha256: report.planSha256, cleanedNames: report.cleanedNames };
    } finally { this.bridge.sourceBusy.delete(session); }
  }
  async importInput(target, source, names, group, perform, expected = {}) {
    if (group !== 'output') return perform();
    if (!Array.isArray(names) || !names.length) throw Error('请选择本批主结果文件');
    const managed = this.runs(source).filter(run => fs.existsSync(this.recordFile(source, run.id)) || fs.existsSync(path.join(this.location(source, run.id), PLAN)) || fs.existsSync(path.join(this.location(source, run.id), MANIFEST))), known = new Set();
    const normalizedPath = file => { const value = fs.realpathSync(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
    for (const name of names) {
      if (!canonical(name)) throw Error('请使用本批规范文件名确认交接');
      const actual = normalizedPath(this.bridge.download(source, group, name));
      for (const run of managed) {
        const directory = normalizedPath(this.location(source, run.id));
        if (actual.startsWith(directory + path.sep)) {
          known.add(run.id);
          if (!name.startsWith(run.id + '/')) throw Error('不能使用路径别名绕过清洗核验');
        }
      }
    }
    if (!known.size) return perform();
    if (known.size !== 1) throw Error('不能混入多个清洗运行的结果');
    const run = [...known][0], record = this.load(source, run), approved = record.acceptanceConfirmed;
    if (!approved || expected.cleanRunId && expected.cleanRunId !== run || expected.cleanReportId && expected.cleanReportId !== approved.reportId) throw Error('本次清洗结果尚未最终确认或核验引用已变化');
    if (this.bridge.active(source) || this.bridge.active(target)) throw Error('当前文件任务正在运行');
    this.bridge.sourceBusy.add(source); this.bridge.sourceBusy.add(target);
    try {
      const { report } = await this.validate(source, run, approved.reportId);
      if (names.length !== report.cleanedNames.length || new Set(names).size !== names.length || !report.cleanedNames.every(name => names.includes(name))) throw Error('只能交接本次核验通过的完整主结果清单，不能混入待处理或其他文件');
      this.bridge.sourceBusy.delete(source); this.bridge.sourceBusy.delete(target); return perform();
    } finally { this.bridge.sourceBusy.delete(source); this.bridge.sourceBusy.delete(target); }
  }
  close() { for (const child of this.children.values()) child.kill(); }
}
module.exports = { CleanAcceptance, PLAN, MANIFEST, canonical, stateOf };
