'use strict';

// Detached stage inputs. Nothing in a source task is opened for writing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { safeFile } = require('./literature-materials');
const materialBasis = require('./literature-material-replenishment');
const { applyInputCoverage } = require('./literature-extract');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAPER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const STAGES = ['extract', 'validate', 'export'];
const MARKER = 'segment-basis.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const identity = value => JSON.stringify(canonical(value));
// The existing Python schema/material fingerprint uses json.dumps defaults.
function pythonJson(value) {
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ': ' + pythonJson(value[key])).join(', ') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
function hashFile(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function directory(root, id) {
  if (!UUID.test(id || '')) throw new Error('文献任务标识无效');
  let dir = path.resolve(root);
  for (const part of ['.workbench', 'literature', id]) {
    dir = path.join(dir, part); const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('文献任务目录无法安全核对');
  }
  return dir;
}
function document(dir, name, required = false) {
  const file = safeFile(dir, name);
  if (!file || file.size > 20 * 1024 * 1024) { if (required) throw new Error('分段输入缺失或路径不安全：' + name); return null; }
  const bytes = fs.readFileSync(file.file);
  try { return { ...file, name, bytes, json: name.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : null }; }
  catch (_) { if (required) throw new Error('分段输入无法解析：' + name); return null; }
}
function fields(dir) {
  const records = document(dir, 'confirmations.json')?.json?.records;
  const latest = Array.isArray(records) ? records.filter(record => record?.kind === 'fieldDefinitions' && Array.isArray(record.fields)).at(-1) : null;
  if (!latest?.fields?.length || latest.fields.some(field => !field || typeof field.key !== 'string' || !field.key.trim())
      || new Set(latest.fields.map(field => field.key)).size !== latest.fields.length) return null;
  return { record: latest, fields: latest.fields, sha256: sha(pythonJson(latest.fields)) };
}
function materialFingerprint(paper) {
  const keys = ['material_id', 'role', 'label', 'filename', 'path', 'format', 'mime_type', 'size', 'sha256', 'download_status'];
  return sha(pythonJson({ reader: 'materials-reader-v1', paper_id: paper.paper_id, papers: [{
    main_pdf_status: paper.main_pdf_status ?? null, supplement_check: paper.supplement_check ?? null,
    materials: (paper.materials || []).map(material => Object.fromEntries(keys.map(key => [key, material[key] ?? null])))
  }] }));
}
function activePaper(paper) {
  return { ...clone(paper), materials: (paper.materials || []).filter(material => material.role === 'main_pdf'
    || (material.role === 'supplement' && material.excluded_from_supplement_counts !== true)).map(clone) };
}
function loadSource(root, id, live) {
  const dir = directory(root, id), job = document(dir, 'job.json', true).json;
  if (job.id !== id || job.deletedAt || live?.deletedAt) throw new Error('原文献任务不存在或已删除');
  if (job.status === 'running' || live?.status === 'running' || live?.child || live?.browserOpening) throw new Error('原文献任务仍在运行，请先停止或完成');
  if (job.materialReplenishment || job.replenishmentInvalid || fs.existsSync(path.join(dir, materialBasis.MARKER))) {
    if (!materialBasis.readBasis(dir)) throw new Error('原材料任务关联记录无法核对');
  }
  if (job.segmentTask || job.segmentInvalid || fs.existsSync(path.join(dir, MARKER))) readBasis(dir);
  const config = document(dir, 'run_config.json', true).json;
  const candidates = document(dir, 'candidates.json', true).json;
  const dedupe = document(dir, 'dedupe/dedupe.json', true).json;
  const progress = document(dir, 'fulltext/status.json', true).json;
  const manifest = document(dir, 'fulltext/materials.json', true).json;
  if (!Array.isArray(candidates.records) || !Array.isArray(dedupe.groups) || !Array.isArray(progress.items) || !Array.isArray(manifest.papers)) throw new Error('原任务候选、去重或材料快照不完整');
  const ids = progress.items.map(item => item?.paper_id);
  if (ids.some(id => !PAPER.test(id || '')) || new Set(ids).size !== ids.length) throw new Error('原全文清单有无效或重复文献');
  const candidateIds = candidates.records.map(record => record?.candidate_id);
  if (candidateIds.some(id => !PAPER.test(id || '')) || new Set(candidateIds).size !== candidateIds.length) throw new Error('原候选标识无效或重复');
  let schema = fields(dir), schemaSourceJobId = schema ? id : null;
  const sourceLineage = [{ jobId: id, kind: job.materialReplenishment ? 'materials' : job.segmentTask ? 'segment' : 'literature' }];
  const parentId = job.materialReplenishment?.parentJobId || job.segmentTask?.sourceJobId;
  if (UUID.test(parentId || '') && parentId !== id) {
    const parentDir = directory(root, parentId), parent = document(parentDir, 'job.json')?.json;
    if (parent?.id === parentId && !parent.deletedAt) {
      sourceLineage.push({ jobId: parentId, kind: 'literature' });
      if (!schema) { schema = fields(parentDir); if (schema) schemaSourceJobId = parentId; }
    }
  }
  return { root, id, dir, job, config, candidates, dedupe, progress, manifest, schema, schemaSourceJobId, sourceLineage,
    ownSchema: fields(dir), suggestedFields: clone(schema?.fields || config.fieldDefinitions || []) };
}
function paperState(source, paperId) {
  const item = source.progress.items.find(item => item.paper_id === paperId);
  const record = source.candidates.records.find(record => record.candidate_id === paperId)
    || source.dedupe.groups.flatMap(group => group.records || []).find(record => record.candidate_id === paperId);
  const matches = source.manifest.papers.filter(paper => paper.paper_id === paperId);
  const paper = matches.length === 1 ? matches[0] : null;
  const reject = reason => ({ allowed: false, reason });
  let extract = { allowed: true, reason: '本地 PDF 已保存；创建时核对 SHA、身份和可读性' };
  if (!item || !record || !paper || item.status !== 'fetched_pdf' || item.kind && item.kind !== 'pdf'
      || !/^fulltext\/files\/[A-Za-z0-9._-]+\.pdf$/i.test(item.path || '')) extract = reject('没有可复用的已确认正文 PDF');
  const file = item?.path ? safeFile(source.dir, item.path) : null;
  const main = paper?.materials?.find(material => material.role === 'main_pdf' && material.path === item?.path && material.download_status === 'downloaded');
  if (extract.allowed && (!file || !main || !HASH.test(item.content_sha256 || main.sha256 || '') || file.size !== item.size
      || (main.size != null && main.size !== file.size) || paper.main_pdf_status !== 'downloaded')) extract = reject('PDF 原件缺失、大小或保存校验信息不完整');
  const bundle = document(source.dir, 'extraction/inputs/' + paperId + '.json');
  const result = document(source.dir, 'extraction/' + paperId + '.json');
  const schema = source.ownSchema;
  let coverageValid = false;
  if (bundle && result) { try { coverageValid = identity(applyInputCoverage(bundle.json, result.json)) === identity(result.json); } catch (_) { /* malformed input coverage is ineligible */ } }
  let validate = reject('缺少同版本的既有提取结果和字段确认');
  if (extract.allowed && schema && bundle?.json?.paper_id === paperId && result?.json?.paper_id === paperId
      && ['ok', 'partial', 'skipped'].includes(result.json.status) && Array.isArray(result.json.rows) && coverageValid
      && bundle.json.schema_sha256 === schema.sha256 && identity(bundle.json.field_definitions) === identity(schema.fields)
      && bundle.json.fulltext?.kind === 'pdf' && bundle.json.fulltext?.path === item.path
      && bundle.json.fulltext?.content_sha256 === (item.content_sha256 || main?.sha256)
      && bundle.json.materials_fingerprint === materialFingerprint(paper)
      && bundle.json.materials_fingerprint === materialFingerprint(activePaper(paper))) validate = { allowed: true, reason: '复用当前 PDF、材料和字段版本对应的既有提取结果' };
  const validation = document(source.dir, 'validation/validation.json');
  const confirmations = document(source.dir, 'confirmations.json');
  let exportReady = reject('缺少与当前提取和字段版本对应的校验结果');
  if (validate.allowed && validation?.json?.version === 1 && Array.isArray(validation.json.blocking) && Array.isArray(validation.json.pending)
      && validation.json.schema_source === 'confirmations.json#fieldDefinitions@' + schema.record.at
      && fs.statSync(validation.file).mtimeMs >= Math.max(fs.statSync(result.file).mtimeMs, fs.statSync(bundle.file).mtimeMs, fs.statSync(confirmations.file).mtimeMs)
      && [...validation.json.blocking, ...validation.json.pending].every(issue => PAPER.test(issue?.paper_id || ''))) exportReady = { allowed: true, reason: '复用当前版本的提取与校验结果，仅生成导出' };
  return { paperId, title: String(record?.title || item?.title || paperId), item, record, paper, bundle, result, validation,
    eligible: { extract, validate, export: exportReady } };
}
function preview(source) {
  return { sourceJobId: source.id, sourceLineage: source.sourceLineage, suggestedFields: source.suggestedFields,
    schemaSourceJobId: source.schemaSourceJobId, allowedStages: [...STAGES],
    papers: source.progress.items.map(item => { const paper = paperState(source, item.paper_id); return { paperId: paper.paperId, title: paper.title, eligible: paper.eligible }; }) };
}
function request(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['sourceJobId', 'paperIds', 'fromStage', 'until', 'requestId'].includes(key))) throw new Error('分段任务只接受来源、文献选择和起止阶段');
  if (!UUID.test(data.sourceJobId || '') || !UUID.test(data.requestId || '') || !Array.isArray(data.paperIds) || !data.paperIds.length
      || data.paperIds.length > 200 || data.paperIds.some(id => !PAPER.test(id || '')) || new Set(data.paperIds).size !== data.paperIds.length) throw new Error('请明确选择 1–200 篇原文献并提供有效请求标识');
  if (!STAGES.includes(data.fromStage) || !STAGES.includes(data.until) || STAGES.indexOf(data.until) < STAGES.indexOf(data.fromStage)) throw new Error('分段范围只能从提取、校验或导出开始，结束阶段不得早于起点');
  return { ...data, paperIds: [...data.paperIds] };
}
function csv(records) {
  const keys = [...new Set(records.flatMap(record => Object.keys(record)))];
  const cell = value => '"' + String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replace(/"/g, '""') + '"';
  return keys.map(cell).join(',') + '\n' + records.map(record => keys.map(key => cell(record[key])).join(',')).join('\n') + '\n';
}
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function plan(source, data) {
  const selected = data.paperIds.map(id => paperState(source, id));
  for (const paper of selected) if (!paper.eligible[data.fromStage].allowed) throw new Error(paper.paperId + '：' + paper.eligible[data.fromStage].reason);
  const files = new Map(), originals = new Map();
  const put = (name, value) => files.set(name, Buffer.isBuffer(value) ? value : jsonBytes(value));
  const records = selected.map(paper => clone(paper.record));
  const groups = selected.map(paper => ({ canonical_id: paper.paperId, title: paper.title, records: [clone(paper.record)], candidate_ids: [paper.paperId], merge_confidence: 'exact', needs_review: false }));
  const config = { ...clone(source.config), fieldDefinitions: source.suggestedFields };
  put('run_config.json', config); put('candidates.json', { version: 1, records, count: records.length, discovery_complete: true, reused_materials: true });
  put('candidates.csv', Buffer.from(csv(records))); put('dedupe/dedupe.json', { version: 1, groups }); put('dedupe/dedupe.csv', Buffer.from(csv(groups.map(group => ({ canonical_id: group.canonical_id, title: group.title })))));
  const items = selected.map(paper => clone(paper.item)), papers = selected.map(paper => activePaper(paper.paper));
  const counts = Object.fromEntries(['fetched_pdf', 'fetched_html', 'partial', 'abstract_only', 'unavailable', 'needs_attention', 'pending'].map(status => [status, items.filter(item => item.status === status).length]));
  const materialComplete = paper => ['checked', 'none_declared', 'none_found'].includes(paper.supplement_check?.status)
    && paper.materials.filter(item => item.role === 'supplement').every(item => item.download_status === 'downloaded');
  Object.assign(counts, { total: items.length, fetched: counts.fetched_pdf + counts.fetched_html, complete_main: counts.fetched_pdf,
    materials_complete: papers.filter(materialComplete).length,
    materials_partial: papers.filter(paper => !materialComplete(paper) && ['checked', 'none_declared', 'none_found'].includes(paper.supplement_check?.status)).length,
    materials_unverified: papers.filter(paper => !['checked', 'none_declared', 'none_found'].includes(paper.supplement_check?.status)).length });
  counts.material_incomplete = papers.length - counts.materials_complete;
  const reused_from = { sourceJobId: source.id, paperIds: [...data.paperIds] };
  put('fulltext/status.json', { version: source.progress.version || 1, generated_at: source.progress.generated_at || null, items, counts, reused_from });
  put('fulltext/materials.json', { version: source.manifest.version || 1, generated_at: source.manifest.generated_at || null, papers, reused_from });
  for (const paper of papers) for (const material of paper.materials) {
    if (material.download_status !== 'downloaded') continue;
    const expected = material.sha256, entry = safeFile(source.dir, material.path);
    if (!entry || entry.size < 1 || !HASH.test(expected || '') || (material.size != null && material.size !== entry.size)
        || !(material.role === 'main_pdf' ? material.path === selected.find(item => item.paperId === paper.paper_id).item.path
          : material.path.startsWith('fulltext/materials/' + paper.paper_id + '/')) || hashFile(entry.file) !== expected) throw new Error('已保存材料无法通过路径、大小或 SHA 校验：' + paper.paper_id);
    originals.set(material.path, { file: entry.file, size: entry.size, sha256: expected });
  }
  if (data.fromStage !== 'extract') {
    put('confirmations.json', { records: [clone(source.ownSchema.record)] });
    for (const paper of selected) { put(paper.bundle.name, paper.bundle.bytes); put(paper.result.name, paper.result.bytes); }
    if (data.fromStage === 'export') {
      const validation = clone(selected[0].validation.json), ids = new Set(data.paperIds);
      validation.blocking = validation.blocking.filter(issue => ids.has(issue.paper_id)); validation.pending = validation.pending.filter(issue => ids.has(issue.paper_id));
      const rows = selected.reduce((count, paper) => count + (paper.result.json.status === 'skipped' ? 0 : paper.result.json.rows.length), 0);
      const count = (issues, entity) => issues.filter(issue => issue.entity === entity).length;
      validation.counts = { parameters_total: rows, ok: Math.max(0, rows - count(validation.blocking, 'parameter') - count(validation.pending, 'parameter')),
        blocking: count(validation.blocking, 'parameter'), pending: count(validation.pending, 'parameter'), literature_total: selected.length,
        literature_blocking: count(validation.blocking, 'literature'), literature_pending: count(validation.pending, 'literature') };
      put('validation/validation.json', validation); put('validation/validation.md', Buffer.from('# 复用校验结果（仅本次所选文献）\n\n' + JSON.stringify(validation.counts) + '\n'));
    }
  }
  const counters = { candidates: selected.length, uniqueGroups: selected.length, fulltextFetched: counts.fetched, fulltextPdf: counts.fetched_pdf,
    fulltextHtml: counts.fetched_html, fulltextComplete: counts.complete_main, materialsComplete: counts.materials_complete,
    materialsPartial: counts.materials_partial, materialsUnverified: counts.materials_unverified,
    extractedPapers: data.fromStage === 'extract' ? 0 : selected.length,
    parameterRows: data.fromStage === 'extract' ? 0 : selected.reduce((count, paper) => count + (paper.result.json.status === 'skipped' ? 0 : paper.result.json.rows.length), 0) };
  return { source, data, selected, config, files, originals, counters };
}
function create(root, id, prepared) {
  const base = path.join(root, '.workbench/literature'), dir = path.join(base, id);
  if (!UUID.test(id) || fs.existsSync(dir)) throw new Error('分段任务目录已存在');
  fs.mkdirSync(dir);
  try {
    const inputs = {};
    for (const [name, bytes] of prepared.files) { const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' }); inputs[name] = { sha256: sha(bytes), size: bytes.length, metadata: true }; }
    for (const [name, file] of prepared.originals) {
      const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file.file, target, fs.constants.COPYFILE_EXCL);
      if (hashFile(target) !== file.sha256) throw new Error('材料复制后 SHA 不一致'); inputs[name] = { sha256: file.sha256, size: file.size, metadata: false };
    }
    const { sourceJobId, paperIds, fromStage, until, requestId } = prepared.data;
    const basis = { version: 1, kind: 'literature-segment', sourceJobId, paperIds, fromStage, until, requestId, createdAt: new Date().toISOString(),
      schemaLocked: fromStage !== 'extract', sourceLineage: prepared.source.sourceLineage, inputs, inputSnapshotSha256: sha(identity(inputs)) };
    fs.writeFileSync(path.join(dir, MARKER), jsonBytes(basis), { flag: 'wx' });
    return { dir, basis: readBasis(dir) };
  } catch (error) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(base) || !UUID.test(path.basename(dir))) throw new Error('分段临时目录无法安全核对');
    fs.rmSync(dir, { recursive: true, force: true }); throw error;
  }
}
function readBasis(dir, { verifyFiles = false } = {}) {
  const basis = document(dir, MARKER, true).json;
  request({ sourceJobId: basis.sourceJobId, paperIds: basis.paperIds, fromStage: basis.fromStage, until: basis.until, requestId: basis.requestId });
  if (basis.version !== 1 || basis.kind !== 'literature-segment' || basis.sourceJobId === path.basename(dir)
      || !basis.inputs || typeof basis.inputs !== 'object' || !Number.isFinite(Date.parse(basis.createdAt))
      || sha(identity(basis.inputs)) !== basis.inputSnapshotSha256) throw new Error('分段任务冻结记录无效');
  for (const [name, receipt] of Object.entries(basis.inputs)) {
    const file = safeFile(dir, name);
    if (!file || file.size !== receipt.size || !HASH.test(receipt.sha256 || '') || ((receipt.metadata || verifyFiles) && hashFile(file.file) !== receipt.sha256)) throw new Error('分段任务冻结输入发生变化：' + name);
  }
  for (const name of ['run_config.json', 'candidates.json', 'candidates.csv', 'dedupe/dedupe.json', 'dedupe/dedupe.csv', 'fulltext/status.json', 'fulltext/materials.json']) {
    if (!basis.inputs[name]?.metadata) throw new Error('分段冻结输入不完整');
  }
  const selected = [...basis.paperIds].sort().join('\n');
  for (const [name, key, idKey] of [['candidates.json', 'records', 'candidate_id'], ['dedupe/dedupe.json', 'groups', 'canonical_id'],
    ['fulltext/status.json', 'items', 'paper_id'], ['fulltext/materials.json', 'papers', 'paper_id']]) {
    const values = document(dir, name, true).json[key];
    if (!Array.isArray(values) || values.map(value => value?.[idKey]).sort().join('\n') !== selected) throw new Error('分段任务文献选择发生变化');
  }
  const ids = new Set(basis.paperIds);
  for (const prefix of ['extraction', 'extraction/inputs']) {
    const target = path.join(dir, prefix);
    if (!fs.existsSync(target)) continue;
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('分段输出目录不安全');
    for (const name of fs.readdirSync(target)) if (name.endsWith('.json') && name !== 'check_report.json' && !ids.has(name.slice(0, -5))) throw new Error('分段任务包含未选择的文献产物');
  }
  return { sourceJobId: basis.sourceJobId, paperIds: [...basis.paperIds], fromStage: basis.fromStage, until: basis.until,
    createdAt: basis.createdAt, requestId: basis.requestId, inputSnapshotSha256: basis.inputSnapshotSha256, schemaLocked: basis.fromStage !== 'extract' };
}
function assertStage(dir, stage) {
  const basis = readBasis(dir, { verifyFiles: true });
  if (!STAGES.includes(stage) || STAGES.indexOf(stage) < STAGES.indexOf(basis.fromStage) || STAGES.indexOf(stage) > STAGES.indexOf(basis.until)) throw new Error('执行阶段超出已确认的分段范围');
  if (stage !== 'extract') {
    const source = { dir, ownSchema: fields(dir), candidates: document(dir, 'candidates.json', true).json,
      dedupe: document(dir, 'dedupe/dedupe.json', true).json, progress: document(dir, 'fulltext/status.json', true).json,
      manifest: document(dir, 'fulltext/materials.json', true).json };
    for (const paperId of basis.paperIds) {
      const state = paperState(source, paperId), eligibility = state.eligible[stage];
      if (!eligibility.allowed) throw new Error(paperId + '：' + eligibility.reason);
    }
  }
  return basis;
}
const PREFLIGHT = [
  'import sys,json,pathlib', 'sys.path.insert(0,sys.argv[1])',
  'from literature_fulltext_reuse import inspect_saved', 'from literature_extract import extract_pdf_text',
  'p=pathlib.Path(sys.argv[2]); ids=json.loads(sys.argv[3]); c=json.loads((p/"candidates.json").read_text(encoding="utf-8")); s=json.loads((p/"fulltext/status.json").read_text(encoding="utf-8")); d=json.loads((p/"dedupe/dedupe.json").read_text(encoding="utf-8"))',
  'records={r["candidate_id"]:r for r in c.get("records",[])}',
  'for g in d.get("groups",[]):', ' for r in g.get("records",[]): records.setdefault(r.get("candidate_id"),r)',
  'items={i["paper_id"]:i for i in s["items"]}; out=[]',
  'for i in ids:', ' item=items[i]; checked=inspect_saved(p,item,records[i],for_reuse=True); text,reason=extract_pdf_text(p/item["path"]) if checked["status"]=="valid" else ("",checked["reason"])',
  ' out.append({"paperId":i,"allowed":checked["status"]=="valid" and bool(text.strip()) and not reason,"reason":str(reason or checked["reason"])[:500]})',
  'print(json.dumps(out,ensure_ascii=False))'
].join('\n');
function preflight(root, source, ids, spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, ['-c', PREFLIGHT, path.join(root, 'tools'), source.dir, JSON.stringify(ids)],
      { cwd: root, windowsHide: true, env: { ...process.env, ...spec.environment, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    let output = '', errors = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('本地 PDF 预检超时；没有创建或运行分段任务')); }, Math.max(30000, ids.length * 15000));
    function finish(error) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else { try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('本地 PDF 预检未返回有效结果')); } } }
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 512000) { child.kill(); finish(new Error('本地预检输出过大')); } });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
    child.on('error', finish); child.on('close', code => finish(code === 0 ? null : new Error('本地 PDF 预检失败：' + errors)));
  });
}
module.exports = { MARKER, STAGES, loadSource, preview, request, plan, create, readBasis, assertStage, preflight, fields, identity, materialFingerprint };
