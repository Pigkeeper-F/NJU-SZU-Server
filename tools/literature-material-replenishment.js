'use strict';

// A materials-only child owns its mutable acquisition files. Frozen inputs and
// prior verified materials are copied; no parent file or downstream result is
// ever opened for writing by this module.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeFile } = require('./literature-materials');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAPER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const INPUTS = ['run_config.json', 'candidates.json', 'candidates.csv', 'dedupe/dedupe.json', 'dedupe/dedupe.csv'];
const HASH_KEYS = ['configSnapshotSha256', 'candidateSnapshotSha256', 'candidateCsvSnapshotSha256', 'dedupeSnapshotSha256', 'dedupeCsvSnapshotSha256'];
const MARKER = 'materials-basis.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fileHash(file) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function document(dir, name, required = true) {
  const entry = safeFile(dir, name);
  if (!entry) { if (!required && !fs.existsSync(path.join(dir, name))) return null; throw new Error('材料补齐输入缺失或路径不安全：' + name); }
  if (entry.size > 20 * 1024 * 1024) throw new Error('材料补齐输入清单过大：' + name);
  const bytes = fs.readFileSync(entry.file);
  return { name, bytes, json: name.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : null };
}
function jobDirectory(root, id) {
  if (!UUID.test(id || '')) throw new Error('无效文献任务标识');
  let dir = path.resolve(root);
  for (const segment of ['.workbench', 'literature', id]) {
    dir = path.join(dir, segment);
    const entry = fs.lstatSync(dir);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('文献任务目录不安全');
  }
  return dir;
}
function inputSnapshot(dir) {
  const files = INPUTS.map(name => document(dir, name));
  const config = files[0].json, candidateDoc = files[1].json, dedupe = files[3].json;
  const records = Array.isArray(candidateDoc?.records) ? candidateDoc.records : candidateDoc?.results;
  if (!config || !Array.isArray(config.sources) || !Array.isArray(records) || !records.length
      || !Array.isArray(dedupe?.groups) || !dedupe.groups.length
      || (Object.hasOwn(candidateDoc, 'count') && candidateDoc.count !== records.length)) throw new Error('原候选或去重快照不完整');
  const ids = records.map(record => record?.candidate_id);
  if (ids.some(id => !PAPER.test(id || '')) || new Set(ids).size !== ids.length) throw new Error('原候选标识不完整或重复');
  const groupIds = dedupe.groups.map(group => group?.canonical_id);
  if (groupIds.some(id => !ids.includes(id)) || new Set(groupIds).size !== groupIds.length) throw new Error('去重输入不属于原候选快照');
  const hashes = Object.fromEntries(files.map((file, index) => [HASH_KEYS[index], sha(file.bytes)]));
  return { files, config, records, groupIds, hashes, snapshotSha256: sha(JSON.stringify(hashes)) };
}
function readBasis(dir) {
  if (!fs.existsSync(path.join(dir, MARKER))) return null;
  const basis = document(dir, MARKER).json;
  if (basis?.version !== 1 || basis.kind !== 'material-replenishment' || !UUID.test(basis.parentJobId || '') || basis.parentJobId === path.basename(dir)
      || !Number.isSafeInteger(basis.candidateCount) || basis.candidateCount < 1
      || !Number.isFinite(Date.parse(basis.createdAt)) || !HASH.test(basis.snapshotSha256 || '')) throw new Error('材料补齐关联记录无效');
  const snapshot = inputSnapshot(dir);
  if (snapshot.records.length !== basis.candidateCount || snapshot.snapshotSha256 !== basis.snapshotSha256
      || HASH_KEYS.some(key => basis[key] !== snapshot.hashes[key])) throw new Error('材料补齐冻结输入发生变化，请先核对原记录');
  return { parentJobId: basis.parentJobId, candidateCount: basis.candidateCount,
    createdAt: basis.createdAt, snapshotSha256: basis.snapshotSha256 };
}
function materialsPath(name, paperId) {
  return typeof name === 'string' && (new RegExp('^fulltext/files/' + paperId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(?:pdf|txt)$', 'i').test(name)
    || name.startsWith('fulltext/materials/' + paperId + '/'));
}
function sourceSnapshot(root, id, live, { verifyMaterials = true } = {}) {
  const dir = jobDirectory(root, id), saved = document(dir, 'job.json').json;
  const current = live || saved;
  if (!saved || saved.id !== id || current.deletedAt || saved.deletedAt) throw new Error('原任务不存在或已删除');
  if (saved.materialReplenishment || live?.materialReplenishment || saved.replenishmentInvalid || fs.existsSync(path.join(dir, MARKER))) throw new Error('请继续当前材料补齐记录，不能从补齐记录再创建子任务');
  if (!['completed', 'needs_attention', 'failed', 'cancelled'].includes(current.status)
      || saved.status === 'running' || current.child || current.browserOpening) throw new Error('原任务仍在运行，请停止或完成后再补齐材料');
  const snapshot = inputSnapshot(dir), statusFile = document(dir, 'fulltext/status.json');
  const manifestFile = document(dir, 'fulltext/materials.json', false);
  const status = statusFile.json, manifest = manifestFile?.json;
  if (!Array.isArray(status?.items) || status.items.some(item => !snapshot.groupIds.includes(item?.paper_id))
      || new Set(status.items.map(item => item.paper_id)).size !== status.items.length) throw new Error('原全文进度与候选快照不一致');
  if (manifest && (!Array.isArray(manifest.papers) || manifest.papers.some(paper => !snapshot.groupIds.includes(paper?.paper_id))
      || new Set(manifest.papers.map(paper => paper.paper_id)).size !== manifest.papers.length)) throw new Error('原材料清单与候选快照不一致');
  const copies = new Map();
  const register = (relative, paperId, expected, size, needsHash) => {
    if (!materialsPath(relative, paperId)) throw new Error('材料路径不属于原文献，不能作为已保存文件复用');
    const entry = safeFile(dir, relative);
    if (!entry || entry.size < 1 || (Number.isSafeInteger(size) && size !== entry.size)) throw new Error('已登记材料缺失、大小变化或路径不安全');
    if ((expected && !HASH.test(expected)) || (needsHash && !HASH.test(expected || ''))) throw new Error('已登记材料缺少有效 SHA 校验值');
    const actual = verifyMaterials ? fileHash(entry.file) : expected || '';
    if (expected && expected !== actual) throw new Error('已登记材料 SHA 校验不一致；原文件保留，请先核对');
    const previous = copies.get(relative);
    if (previous && previous.sha256 !== actual) throw new Error('材料文件身份冲突');
    copies.set(relative, { name: relative, file: entry.file, sha256: actual });
  };
  for (const paper of manifest?.papers || []) for (const item of paper.materials || []) {
    if (item.download_status === 'downloaded') register(item.path, paper.paper_id, item.sha256, item.size, true);
  }
  for (const item of status.items) {
    if (['fetched_pdf', 'fetched_html'].includes(item.status) && !item.path) throw new Error('原正文登记缺少材料文件路径');
    if (item.path) {
      const registered = copies.get(item.path);
      register(item.path, item.paper_id, item.content_sha256 || registered?.sha256, item.size, ['fetched_pdf', 'fetched_html'].includes(item.status));
    }
  }
  const gap = snapshot.groupIds.some(id => {
    const paper = manifest?.papers?.find(item => item.paper_id === id);
    return !paper || paper.main_pdf_status !== 'downloaded'
      || !(paper.materials || []).some(item => item.role === 'main_pdf' && item.download_status === 'downloaded' && copies.has(item.path))
      || !['checked', 'none_declared'].includes(paper.supplement_check?.status)
      || (paper.materials || []).some(item => item.role === 'supplement' && item.download_status !== 'downloaded');
  });
  if (!gap) throw new Error('已登记正文 PDF 与补充材料均已取得，无需重复补齐');
  return { ...snapshot, parentJobId: id, statusFile, manifestFile, copies: [...copies.values()] };
}
function eligible(root, id, live) {
  // Capability reads validate the small manifests/paths and existence only.
  // Rehashing gigabyte attachments on every UI poll would block this process.
  // The explicit action always calls sourceSnapshot with full hashing enabled.
  try { sourceSnapshot(root, id, live, { verifyMaterials: false }); return true; } catch (_) { return false; }
}
function createSnapshot(root, id, snapshot) {
  const base = path.join(root, '.workbench', 'literature'), dir = path.join(base, id);
  if (!UUID.test(id || '') || fs.existsSync(dir)) throw new Error('材料补齐记录目录已存在');
  fs.mkdirSync(dir);
  try {
    for (const file of [...snapshot.files, snapshot.statusFile, snapshot.manifestFile].filter(Boolean)) {
      const target = path.join(dir, file.name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes, { flag: 'wx' });
    }
    for (const file of snapshot.copies) {
      const target = path.join(dir, file.name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.file, target, fs.constants.COPYFILE_EXCL);
      if (fileHash(target) !== file.sha256) throw new Error('材料复制校验失败，未开始下载');
    }
    const basis = { version: 1, kind: 'material-replenishment', parentJobId: snapshot.parentJobId,
      candidateCount: snapshot.records.length, createdAt: new Date().toISOString(), ...snapshot.hashes,
      snapshotSha256: snapshot.snapshotSha256, copiedMaterials: snapshot.copies.map(file => ({ path: file.name, sha256: file.sha256 })) };
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(basis, null, 2) + '\n', { flag: 'wx' });
    return { dir, basis };
  } catch (error) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(base) || !UUID.test(path.basename(dir))) throw new Error('材料补齐临时目录无法核对');
    fs.rmSync(dir, { recursive: true, force: true }); throw error;
  }
}
// Manual reports are a read-only projection of this child's frozen papers.
// URLs are displayed to the researcher; page opening uses a saved browser
// binding and the paper ID, never a URL received from the HTTP request.
const AUTH_REASONS = new Set(['login', 'verification', 'access_required']);
function actionReport(dir, name, status, accepts) {
  try {
    const report = document(dir, 'fulltext/' + name + '.json', false)?.json;
    if (report?.version !== 1 || !Array.isArray(report.items)) return [];
    const snapshot = inputSnapshot(dir), titles = new Map(snapshot.records.map(record => [record.candidate_id, record.title]));
    const allowed = new Set(snapshot.groupIds), seen = new Set();
    const string = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
    const officialUrl = value => {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
      catch (_) { return ''; }
    };
    return report.items.flatMap(item => {
      const paperId = item?.paper_id;
      if (!allowed.has(paperId) || seen.has(paperId) || item.status !== status || !accepts(item.reason)) return [];
      seen.add(paperId);
      return [{ paperId, title: string(item.title || titles.get(paperId), 1000), status,
        reason: string(item.reason, 100), message: string(item.message, 3000), officialUrl: officialUrl(item.official_url),
        mainPdfMissing: item.main_pdf_missing === true,
        supplements: { status: string(item.supplements?.status, 100), checkStatus: string(item.supplements?.check_status, 100),
          missing: (Array.isArray(item.supplements?.missing) ? item.supplements.missing : []).slice(0, 200)
            .map(value => string(typeof value === 'string' ? value : value?.label || value?.name || value?.title || value?.path || value?.material_id, 500)).filter(Boolean) } }];
    });
  } catch (_) { return []; }
}
function manualActions(dir) { return actionReport(dir, 'manual-actions', 'needs_attention', reason => AUTH_REASONS.has(reason)); }
function skippedActions(dir) { return actionReport(dir, 'skipped-materials', 'skipped', reason => typeof reason === 'string' && !!reason && !AUTH_REASONS.has(reason)); }
module.exports = { MARKER, sourceSnapshot, readBasis, eligible, createSnapshot, manualActions, skippedActions };
