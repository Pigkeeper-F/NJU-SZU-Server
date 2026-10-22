'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { createHash, randomUUID } = require('node:crypto');
const { fetchSource } = require('./source-download');
const { transferArchive, transferFile, hashFile, officialUrl, readJson, writeJson, MAX_ARCHIVE_BYTES } = require('./source-transfer');
const ID = /^[0-9a-f-]{36}$/;
const CATALOG = 'https://bulks-faostat.fao.org/production/datasets_E.json';
const FILTERS = ['reporterCodes', 'partnerCodes', 'itemCodes', 'elementCodes', 'elementNames', 'itemNames', 'reporterNames', 'partnerNames'];
const NAME_FILTERS = new Set(['elementNames', 'itemNames', 'reporterNames', 'partnerNames']);
const TYPES = /\.(csv|tsv|xlsx|xls|json|txt|zip|pdf|xml|md)$/i;
const sha = text => createHash('sha256').update(text).digest('hex');
function isFaostatPlan(rules) { return /FAOSTAT|fao\.org/i.test(rules) && /贸易矩阵|Detailed\s*trade\s*matrix|\bTM\b/i.test(rules); }
function fileSources(rules) {
  return [...new Set(rules.match(/https?:\/\/[^\s<>"\]]+/g) || [])].map(raw => raw.replace(/[，。；）]+$/, ''))
    .filter(url => TYPES.test(url.split(/[?#]/)[0])).map(url => ({ url, name: decodeURIComponent(path.posix.basename(new URL(url).pathname)) }));
}
function validatePlan(config, rules) {
  if (!config || config.dataset !== 'TM' || !isFaostatPlan(rules)) throw new Error('方案未明确FAOSTAT详细贸易矩阵TM');
  if (Array.isArray(config.unresolved) && config.unresolved.length) throw new Error('请先在对话中明确并修订方案：' + config.unresolved.join('；'));
  if (!Array.isArray(config.years) || !config.years.length || config.years.length > 5 || new Set(config.years).size !== config.years.length || config.years.some(y => !Number.isInteger(y) || y < 1961 || y > 2100 || !new RegExp('(?<!\\d)' + y + '(?!\\d)').test(rules))) throw new Error('下载年份须在已审核方案中明确，单次支持1至5个年份');
  const filters = {};
  if (Object.keys(config.filters || {}).some(key => !FILTERS.includes(key))) throw new Error('存在未支持的范围条件，未忽略该条件');
  for (const key of FILTERS) {
    const values = config.filters?.[key] || [];
    if (!Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== 'string' || !value || value.length > 100)) throw new Error('筛选代码或指标格式无效');
    if (!NAME_FILTERS.has(key) && values.some(value => !/^\d+$/.test(value) || !new RegExp('(?<!\\d)' + value + '(?!\\d)').test(rules))) throw new Error('国家、商品或要素代码必须在方案中明确，不能猜测代码');
    if (NAME_FILTERS.has(key) && key !== 'elementNames' && values.some(value => !rules.toLocaleLowerCase().includes(value.toLocaleLowerCase()))) throw new Error('筛选名称必须来自已审核方案，正式名称与代码由官方字典核对');
    if (key === 'elementNames') {
      const evidence = { 'Import Quantity': /Import\s*Quantity|进口(?:量|数量)|进出口数量/i, 'Export Quantity': /Export\s*Quantity|出口(?:量|数量)|进出口数量/i,
        'Import Value': /Import\s*Value|进口(?:额|金额|价值)|进出口金额/i, 'Export Value': /Export\s*Value|出口(?:额|金额|价值)|进出口金额/i };
      if (values.some(value => !Object.entries(evidence).find(([name]) => name.toLowerCase() === value.toLowerCase())?.[1].test(rules))) throw new Error('指标限定缺少方案依据');
    }
    if (values.length) filters[key] = [...new Set(values)];
  }
  return { dataset: 'TM', years: [...config.years].sort(), filters, scopeNote: String(config.scopeNote || '未指定的国家、商品和指标不作筛选，保留官方记录').slice(0, 1000) };
}
function structuredPlan(rules) {
  const cell = label => rules.split(/\r?\n/).map(line => line.split('|').map(value => value.trim())).find(parts => parts[1] === label)?.[2] || '';
  const year = cell('目标年份') || cell('年份');
  const item = cell('商品范围').split(/[；;]/)[0];
  const reporter = cell('报告国范围'), partner = cell('贸易伙伴范围');
  const indicators = (cell('进出口指标') || cell('指标范围')).split(/[；;]/)[0];
  const years = [...new Set((year.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) || []).map(Number))];
  const named = /^(?:已确认)?(?:限定为|仅为|仅限于?|采用|为)?\s*([^()（）]+?)\s*[（(]([^()（）]+)[)）]\s*$/.exec(item);
  if (!named || years.length !== 1 || !/全部报告国/.test(reporter) || !/全部贸易伙伴/.test(partner)
    || /仅|限定|只(?:选|保留|含)|排除|不含/.test(reporter + partner) || !/进口数量/.test(indicators) || !/出口数量/.test(indicators)
    || /(?:禁止|不允许|不得)[^\n。；]{0,15}(?:整包|压缩包)|仅允许[^\n。]{0,12}直接导出/.test(rules)) return null;
  const rest = indicators.replace(/不(?:包含|含)(?:贸易)?(?:金额|价值)/g, '');
  if (/金额|价值/.test(rest)) return null;
  return validatePlan({ dataset: 'TM', years, filters: { itemNames: [named[2].trim()], elementNames: ['Import quantity', 'Export quantity'] },
    scopeNote: named[2].trim() + '；全部报告国和贸易伙伴（含来源汇总项）；仅进口与出口数量，正式代码和单位由官方数据核对' }, rules);
}
async function interpretPlan(rules, generate, signal) {
  const structured = structuredPlan(rules);
  if (structured) return structured;
  if (generate) {
    const prompt = '从已审核方案提取研究范围，返回JSON，不调用工具，不猜代码或网址。当前平台已支持FAOSTAT TM官方整包自动定位、2GiB流式获取、包内官方字典核对名称代码、实际年份与单位核对及目标记录另存。这些是程序已具备的事实；下载URL、文件大小、商品代码、正式名称大小写、指标单位及年份可用性待官方核对，均交执行器完成，不能列为unresolved。旧方案中20MB或技术路径待核对的文字不表示研究范围未定，也不额外要求用户找链接或先查代码。只在真的缺少业务选择、明确禁止当前获取方法、或要求未支持的转换/合并时列unresolved；保留原件并另存目标记录不属于改写原件或科学清洗。\n返回 {"dataset":"TM","years":[2024],"filters":{"reporterCodes":[],"partnerCodes":[],"itemCodes":[],"elementCodes":[],"elementNames":[],"itemNames":[],"reporterNames":[],"partnerNames":[]},"scopeNote":"范围说明","unresolved":[]}。名称用方案中原文，例如itemNames:["Wheat"]或["小麦"]；平台将从包内官方字典唯一精确匹配，真实多义才停止。代码只有方案已明确时才填，不把M49猜成FAO代码。进口/出口数量使用elementNames:["Import quantity","Export quantity"]，金额对应Import value/Export value；正式代码和单位由执行器核对，不猜。不得忽略已明确的小麦、国家、年份或数量限定；仅未指定/不限的范围保留全部。当前请求由用户审核方案并点击执行发起，未执行/待核对等旧状态不冒充新的业务审批。只返回JSON。\n\n已审核方案：\n' + rules;
    const text = String(await generate(prompt, signal));
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('未能从方案读取下载范围，请在对话中明确数据集和年份');
    return validatePlan(JSON.parse(text.slice(start, end + 1)), rules);
  }
  const years = [...new Set((rules.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) || []).map(Number))];
  // Deterministic path for an explicit year-only request. Complex scopes require the selected assistant.
  if (years.length !== 1 || /仅|限定|排除|不下载|只下载|only|exclude|import quantity|export quantity/i.test(rules)) throw new Error('请连接本模块助手，以便读取已审核方案中的具体筛选条件');
  return validatePlan({ dataset: 'TM', years, filters: {} }, rules);
}
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) || !TYPES.test(name)) throw new Error('无效下载文件名');
  return name;
}
class SourceDownloads {
  constructor(root, bridge, options = {}) {
    this.root = root; this.bridge = bridge; this.options = options; this.running = new Map();
    if (options.recover === true) this.recoverInterrupted();
  }
  recoverInterrupted() {
    const base = path.join(this.root, '.workbench');
    if (!fs.existsSync(base)) return;
    for (const session of fs.readdirSync(base).filter(id => ID.test(id))) {
      const output = path.join(base, session, 'output');
      if (!fs.existsSync(output)) continue;
      for (const id of fs.readdirSync(output).filter(id => ID.test(id))) {
        const file = path.join(output, id, 'run-state.json');
        const job = readJson(file);
        if (job?.sourceJob === true && job.status === 'running') { job.status = 'interrupted'; job.message = '服务重启，已有文件和断点保留，请继续原任务'; job.updatedAt = new Date().toISOString(); writeJson(file, job); }
      }
    }
  }
  location(sessionId, id) {
    if (!ID.test(id || '')) throw new Error('无效下载任务标识');
    return path.join(this.bridge.session(sessionId), 'output', id);
  }
  load(sessionId, id) {
    const job = readJson(path.join(this.location(sessionId, id), 'run-state.json'));
    if (!job?.sourceJob || job.id !== id || job.sessionId !== sessionId) throw new Error('下载任务不存在');
    return job;
  }
  save(job) { job.updatedAt = new Date().toISOString(); writeJson(path.join(this.location(job.sessionId, job.id), 'run-state.json'), job); }
  snapshot(sessionId, id) { const { rules, catalog, ...job } = this.load(sessionId, id); return { ...job, files: this.bridge.files(sessionId) }; }
  start(sessionId, rules, generate) {
    if (typeof rules !== 'string' || !rules.trim() || rules.length > 20000) throw new Error('请先审核下载方案');
    this.bridge.session(sessionId);
    if (this.bridge.active(sessionId) || this.running.size) throw new Error('下载或文件任务正在运行，请等待完成或先停止');
    const kind = isFaostatPlan(rules) ? 'faostat-tm' : 'files';
    const sources = kind === 'files' ? fileSources(rules) : [];
    if (kind === 'files' && (!sources.length || sources.length > 5)) throw new Error('此数据源尚未接入自动定位。请在方案中提供实际公开文件地址；已有接口可接入同一下载任务');
    sources.forEach(source => safeName(source.name));
    const id = randomUUID(); fs.mkdirSync(this.location(sessionId, id));
    const job = { sourceJob: true, id, sessionId, kind, rules, rulesSha256: sha(rules), sources,
      status: 'running', stage: 'plan', message: '读取已审核方案', progress: {}, deliverables: [], createdAt: new Date().toISOString() };
    this.save(job); fs.writeFileSync(path.join(this.location(sessionId, id), 'approved-plan.md'), rules);
    this.launch(job, generate); return this.snapshot(sessionId, id);
  }
  resume(sessionId, id, rules, generate) {
    const job = this.load(sessionId, id);
    if (rules !== job.rules) throw new Error('方案已修改，请按新方案建立新任务；旧文件保留');
    if (job.status === 'completed') return this.snapshot(sessionId, id);
    if (this.bridge.active(sessionId) || this.running.size) throw new Error('当前仍有下载或文件任务运行');
    job.status = 'running'; job.error = ''; job.message = '继续原下载任务'; this.save(job); this.launch(job, generate);
    return this.snapshot(sessionId, id);
  }
  cancel(sessionId, id) {
    const job = this.load(sessionId, id), run = this.running.get(id);
    if (run) { run.cancelled = true; run.controller.abort(new Error('用户停止下载')); run.child?.kill(); }
    return this.snapshot(sessionId, id);
  }
  launch(job, generate) {
    const run = { controller: new AbortController(), cancelled: false, child: null };
    this.running.set(job.id, run); this.bridge.sourceBusy.add(job.sessionId);
    Promise.resolve().then(() => this.execute(job, run, generate)).then(() => {
      job.status = 'completed'; job.stage = 'completed'; job.message = '下载与筛选完成，结果待人工检查后交接';
    }).catch(error => {
      job.status = run.cancelled ? 'cancelled' : 'failed'; job.error = error.message; job.message = run.cancelled ? '已停止，完整文件与下载断点保留' : '任务未完成：' + error.message;
    }).finally(() => { try { this.save(job); } finally { this.running.delete(job.id); this.bridge.sourceBusy.delete(job.sessionId); } }).catch(() => {});
  }
  update(job, stage, message, progress) {
    job.stage = stage; job.message = message; if (progress) job.progress = { ...job.progress, ...progress };
    this.save(job);
  }
  async execute(job, run, generate) {
    const output = this.location(job.sessionId, job.id);
    const staging = path.join(this.bridge.session(job.sessionId), '.source-staging', job.id);
    fs.mkdirSync(staging, { recursive: true });
    if (job.kind === 'files') return this.executeFiles(job, run, output, staging);
    if (!job.config) { job.config = await interpretPlan(job.rules, generate, run.controller.signal); this.save(job); }
    if (run.controller.signal.aborted) throw new Error('任务已停止');
    this.update(job, 'catalog', '自动定位FAOSTAT官方贸易矩阵压缩包');
    if (!job.catalog) {
      const index = await (this.options.fetchCatalog || (() => fetchSource({ url: CATALOG }, { signal: run.controller.signal })))();
      const catalog = JSON.parse(index.data.toString('utf8')).Datasets?.Dataset;
      const matches = Array.isArray(catalog) ? catalog.filter(record => record.DatasetCode === 'TM') : [];
      if (matches.length !== 1 || !/\.zip$/i.test(new URL(matches[0].FileLocation).pathname)) throw new Error('官方目录无法唯一定位TM压缩包');
      officialUrl(matches[0].FileLocation); job.catalog = matches[0]; this.save(job);
    }
    const catalog = job.catalog, key = sha(catalog.FileLocation + '\n' + catalog.DateUpdate);
    const cache = path.join(this.root, '.workbench', 'source-cache', key); fs.mkdirSync(cache, { recursive: true });
    writeJson(path.join(cache, 'catalog.json'), catalog);
    const archive = path.join(cache, 'archive.zip'), completeFile = path.join(cache, 'complete.json');
    let complete = readJson(completeFile);
    this.update(job, 'download', '下载官方整包，按实际字节显示进度');
    let reusable = complete?.source === catalog.FileLocation && fs.existsSync(archive) && !fs.lstatSync(archive).isSymbolicLink() && fs.statSync(archive).size === complete.size;
    if (reusable) { this.update(job, 'verify', '复核已完整获取的官方原包SHA256，避免重复下载'); reusable = await hashFile(archive) === complete.sha256; }
    if (!reusable) {
      const partial = path.join(cache, 'archive.part'); let last = 0;
      const transfer = this.options.transferArchive || transferArchive;
      complete = await transfer(catalog.FileLocation, partial, { signal: run.controller.signal, onProgress: progress => {
        if (Date.now() - last > 600 || progress.bytes === progress.totalBytes) { last = Date.now(); this.update(job, 'download', '正在下载官方原始压缩包', progress); }
      } });
      fs.renameSync(partial, archive); complete = { ...complete, source: catalog.FileLocation, catalogDate: catalog.DateUpdate, completedAt: new Date().toISOString() }; writeJson(completeFile, complete);
    }
    if (run.controller.signal.aborted) throw new Error('任务已停止');
    const archiveName = 'FAOSTAT_TM_original.zip', archiveTarget = path.join(output, archiveName);
    if (!fs.existsSync(archiveTarget)) { await fs.promises.copyFile(archive, archiveTarget, fs.constants.COPYFILE_EXCL); fs.chmodSync(archiveTarget, 0o444); }
    else if (await hashFile(archiveTarget) !== complete.sha256) throw new Error('本次已保存原包校验不符，未覆盖历史文件');
    job.archive = { name: job.id + '/' + archiveName, group: 'output', ...complete };
    this.update(job, 'filter', '原包已完整保存，正在流式筛选 ' + job.config.years.join('、') + ' 年数据', { bytes: complete.size, totalBytes: complete.size });
    const attempt = path.join(staging, randomUUID()); fs.mkdirSync(attempt);
    const configPath = path.join(attempt, 'config.json'), reportPath = path.join(attempt, 'filter-report.json'); writeJson(configPath, job.config);
    await this.filter(job, run, archiveTarget, attempt, configPath, reportPath);
    if (run.controller.signal.aborted) throw new Error('任务已停止');
    const report = readJson(reportPath);
    if (!report?.zipCRCVerified || !report.files?.length || report.files.some(file => !Number.isSafeInteger(file.rows) || file.rows <= 0)) throw new Error('未收到通过检查的筛选报告');
    const input = path.join(this.bridge.session(job.sessionId), 'input', job.id); fs.mkdirSync(input, { recursive: true });
    const deliverables = [];
    for (const file of report.files) {
      safeName(file.name); const from = path.join(attempt, file.name), target = path.join(input, file.name);
      if (!fs.existsSync(from) || fs.statSync(from).size !== file.size || await hashFile(from) !== file.sha256) throw new Error('筛选结果校验不符');
      if (!fs.existsSync(target)) { await fs.promises.copyFile(from, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o444); }
      else if (await hashFile(target) !== file.sha256) throw new Error('同名结果已存在且内容不符，未覆盖');
      deliverables.push({ ...file, storedName: job.id + '/' + file.name, group: 'input', finalUrl: complete.finalUrl });
    }
    if (report.resolvedConfig) job.config = report.resolvedConfig;
    job.deliverables = deliverables; job.result = { sourceRows: report.sourceRows, rowsSelected: report.rowsSelected, columns: report.columns, zipCRCVerified: true, officialMappings: report.officialMappings, unitsByElement: report.unitsByElement };
    writeJson(path.join(output, 'source-and-filter-report.json'), { ...report, rulesSha256: job.rulesSha256, config: job.config, catalog, archive: job.archive, fetchedAt: complete.completedAt });
    fs.copyFileSync(path.join(this.root, 'tools', 'faostat_filter.py'), path.join(output, 'faostat_filter.py'));
    writeJson(path.join(output, 'filter-config.json'), job.config);
    fs.writeFileSync(path.join(output, 'README.txt'), 'FAOSTAT TM 官方原包与按年结果\n原包保留全部年份；input目录内CSV仅含所选年份及明确范围。未清洗、补零、去重或换算。\n原始代码（包括M49前导零）以文本保留；Excel导入请将代码列指定为文本。\n筛选脚本为faostat_filter.py，依赖Python标准库，配置见filter-config.json。\n');
    this.update(job, 'verify', '核对完成：CRC、行数、文件大小与SHA256已记录', { rowsRead: report.sourceRows, rowsSelected: report.rowsSelected });
  }
  async executeFiles(job, run, output, staging) {
    const input = path.join(this.bridge.session(job.sessionId), 'input', job.id); fs.mkdirSync(input, { recursive: true });
    for (let i = 0; i < job.sources.length; i++) {
      if (run.controller.signal.aborted) throw new Error('任务已停止');
      const source = job.sources[i], name = safeName(source.name), target = path.join(input, name);
      const prior = job.deliverables.find(item => item.name === name && item.finalUrl);
      if (prior && fs.existsSync(target) && fs.statSync(target).size === prior.size && await hashFile(target) === prior.sha256) continue;
      let last = 0;
      const result = await (this.options.transferFile || transferFile)(source.url, path.join(staging, i + '.part'), { signal: run.controller.signal, onProgress: progress => {
        if (Date.now() - last > 600) { last = Date.now(); this.update(job, 'download', '正在下载 ' + (i + 1) + '/' + job.sources.length + '：' + name, { ...progress, fileIndex: i + 1, fileCount: job.sources.length }); }
      } });
      if (fs.existsSync(target)) throw new Error('本次同名文件已存在，未覆盖：' + name);
      fs.renameSync(path.join(staging, i + '.part'), target); fs.chmodSync(target, 0o444);
      job.deliverables.push({ ...result, name, storedName: job.id + '/' + name, group: 'input' }); this.save(job);
    }
    writeJson(path.join(output, 'source-report.json'), { rulesSha256: job.rulesSha256, sources: job.sources, files: job.deliverables, at: new Date().toISOString() });
  }
  async filter(job, run, archive, output, config, report) {
    if (this.options.filter) return this.options.filter(job, archive, output, config, report);
    const local = path.join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    const python = this.options.python || (fs.existsSync(local) ? local : process.env.WORKBENCH_PYTHON || (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3'));
    await new Promise((resolve, reject) => {
      const child = spawn(python, ['-u', path.join(this.root, 'tools', 'faostat_filter.py'), '--archive', archive, '--config', config, '--output-dir', output, '--report', report], { cwd: this.root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      run.child = child; let errorText = '';
      child.stderr.on('data', bytes => { errorText = (errorText + bytes.toString('utf8')).slice(-2000); });
      readline.createInterface({ input: child.stdout }).on('line', line => {
        try { const event = JSON.parse(line); if (event.error) errorText = event.error;
          else if (event.stage === 'lookup') { if (event.resolvedConfig) job.config = event.resolvedConfig; this.update(job, 'lookup', event.message || '官方名称与代码已核对，准备筛选', event); }
          else this.update(job, 'filter', '正在筛选：已扫描 ' + (event.rowsRead || 0).toLocaleString() + ' 行，保留 ' + (event.rowsSelected || 0).toLocaleString() + ' 行', event);
        } catch (_) { /* Ignore non-JSON diagnostics. */ }
      });
      child.once('error', reject); child.once('exit', code => { run.child = null; code === 0 ? resolve() : reject(new Error(errorText || '筛选进程未完成')); });
    });
  }
  close() { for (const run of this.running.values()) { run.cancelled = true; run.controller.abort(); run.child?.kill(); } }
}
module.exports = { SourceDownloads, interpretPlan, validatePlan, structuredPlan, isFaostatPlan, fileSources, CATALOG, MAX_ARCHIVE_BYTES };
