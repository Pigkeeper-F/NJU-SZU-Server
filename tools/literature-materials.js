'use strict';

// Read-only public material inventory. Never runs a task, updates job.files or
// follows an unregistered path. Remote URLs/credentials are not public fields.
const fs = require('node:fs');
const path = require('node:path');
const PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[a-f0-9-]{36}$/;
const ROLES = new Set(['main_pdf', 'main_html', 'supplement']);
const DOWNLOAD = new Set(['pending', 'downloaded', 'missing', 'needs_attention']);
const READ = new Set(['not_checked', 'readable', 'partial', 'unreadable', 'unsupported']);
const SUPPLEMENT = new Set(['uninspected', 'checked', 'none_declared', 'unknown', 'needs_attention']);
function text(value, max = 700) {
  return String(value == null ? '' : value).replace(/https?:\/\/\S+/gi, '[链接已省略]')
    .replace(/\b(?:token|sid|ticket|access_token|authorization|cookie|password)\s*[=:]\s*[^\s,;]+/gi, '[敏感信息已省略]').slice(0, max);
}
function segment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('.')
    && !/[\\/:*?"<>|\x00-\x1f]/.test(value) && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function materialPath(relative, paperId) {
  if (typeof relative !== 'string') return false;
  const parts = relative.split('/');
  if (!parts.every(segment) || parts[0] !== 'fulltext') return false;
  if (parts[1] === 'files') return parts.length === 3 && /\.(?:pdf|txt)$/i.test(parts[2]);
  return parts[1] === 'materials' && parts.length >= 4 && PAPER_ID.test(parts[2]) && (!paperId || parts[2] === paperId);
}
function safeFile(dir, relative) {
  if (typeof relative !== 'string' || !relative.split('/').every(segment)) return null;
  const base = path.resolve(dir), resolved = path.resolve(base, relative);
  if (!resolved.startsWith(base + path.sep)) return null;
  try {
    let current = base;
    if (fs.lstatSync(current).isSymbolicLink()) return null;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return { file: resolved, size: stat.size };
  } catch (_) { return null; }
}
function readJson(dir, relative) {
  const entry = safeFile(dir, relative);
  if (!entry) return null;
  if (entry.size > 20 * 1024 * 1024) throw new Error('材料清单过大，请先核对保存文件；查看不会运行下载');
  try { return JSON.parse(fs.readFileSync(entry.file, 'utf8')); }
  catch (_) { throw new Error('材料清单文件无法解析，原文件保留'); }
}
function projectMaterial(dir, paperId, raw) {
  if (!raw || typeof raw !== 'object' || !ROLES.has(raw.role)) return null;
  const relative = materialPath(raw.path, paperId) ? raw.path : '';
  const entry = relative ? safeFile(dir, relative) : null;
  let download = DOWNLOAD.has(raw.download_status) ? raw.download_status : 'pending';
  let read = READ.has(raw.read_status) ? raw.read_status : 'not_checked';
  let reason = text(raw.read_reason);
  if (download === 'downloaded' && !entry) { download = 'missing'; read = 'unreadable'; reason = '登记材料文件缺失或路径不安全，原记录保留'; }
  if (download === 'downloaded' && entry && Number.isSafeInteger(raw.size) && raw.size !== entry.size) {
    download = 'needs_attention'; read = 'not_checked'; reason = '实际文件大小与材料登记不一致，请核查';
  }
  const available = !!entry && ['downloaded', 'needs_attention'].includes(download);
  const result = { material_id: text(raw.material_id, 150), role: raw.role, label: text(raw.label, 300),
    filename: text(raw.filename || (relative ? path.posix.basename(relative) : ''), 240), path: relative,
    format: text(raw.format, 30), mime_type: text(raw.mime_type, 120), size: entry?.size ?? (Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : 0),
    sha256: /^[a-f0-9]{64}$/.test(raw.sha256 || '') ? raw.sha256 : '', download_status: download,
    download_reason: text(raw.download_reason || raw.reason), read_status: read, read_reason: reason, available };
  const reused = raw.reused_from;
  if (reused && typeof reused === 'object' && UUID.test(reused.job_id || reused.jobId || '')) {
    result.reused_from = { job_id: reused.job_id || reused.jobId,
      paper_id: PAPER_ID.test(reused.paper_id || reused.paperId || '') ? reused.paper_id || reused.paperId : '', material_id: text(reused.material_id, 150) };
  }
  return result;
}
function legacyPapers(status) {
  return (Array.isArray(status?.items) ? status.items : []).filter(item => PAPER_ID.test(item?.paper_id || '')).map(item => {
    const pdf = item.status === 'fetched_pdf', body = item.status === 'fetched_html';
    const materials = typeof item.path === 'string' && item.path ? [{ material_id: 'legacy-' + item.paper_id, role: pdf ? 'main_pdf' : 'main_html',
      label: pdf ? '正文 PDF（旧记录）' : body ? '网页正文文本（旧记录）' : '旧题录/摘要缓存（不算正文）',
      filename: path.posix.basename(item.path), path: item.path, format: pdf ? 'pdf' : 'txt', mime_type: pdf ? 'application/pdf' : 'text/plain',
      size: item.size, sha256: item.content_sha256, download_status: 'downloaded', read_status: 'not_checked',
      read_reason: '旧记录未逐材料登记可读性；取得正文不代表补材齐全' }] : [];
    return { paper_id: item.paper_id, title: item.title, doi: item.doi, main_pdf_status: pdf ? 'downloaded' : item.status === 'needs_attention' ? 'needs_attention' : item.status === 'pending' ? 'pending' : 'missing',
      supplement_check: { status: 'uninspected', reason: '旧任务未检查或登记补充材料，不能认定没有补材' }, materials };
  });
}
function readMaterials(dir) {
  const manifest = readJson(dir, 'fulltext/materials.json');
  if (manifest && (!(manifest.version === 1 || manifest.schema === 1) || !Array.isArray(manifest.papers))) throw new Error('材料清单格式不受支持，原文件保留');
  const legacy = !manifest, papers = legacy ? legacyPapers(readJson(dir, 'fulltext/status.json')) : manifest.papers;
  const projected = [];
  for (const paper of papers) {
    if (!paper || !PAPER_ID.test(paper.paper_id || '')) continue;
    const check = paper.supplement_check || {}, materials = (Array.isArray(paper.materials) ? paper.materials : [])
      .map(raw => projectMaterial(dir, paper.paper_id, raw)).filter(Boolean);
    let pdfStatus = ['pending', 'downloaded', 'missing', 'needs_attention'].includes(paper.main_pdf_status) ? paper.main_pdf_status : 'pending';
    if (pdfStatus === 'downloaded' && !materials.some(item => item.role === 'main_pdf' && item.available)) pdfStatus = 'missing';
    else if (materials.some(item => item.role === 'main_pdf' && item.download_status === 'needs_attention')) pdfStatus = 'needs_attention';
    projected.push({ paper_id: paper.paper_id, title: text(paper.title, 600), doi: text(paper.doi, 300), main_pdf_status: pdfStatus,
      supplement_check: { status: SUPPLEMENT.has(check.status) ? check.status : 'unknown', reason: text(check.reason) }, materials });
  }
  return { schema: 1, legacy, papers: projected };
}
function registeredMaterialFile(dir, name) {
  if (!materialPath(name)) return null;
  const inventory = readMaterials(dir);
  if (!inventory.papers.some(paper => paper.materials.some(item => item.path === name && item.available))) return null;
  return safeFile(dir, name)?.file || null;
}
module.exports = { readMaterials, registeredMaterialFile, safeFile };
