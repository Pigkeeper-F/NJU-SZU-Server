'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ID = /^[a-f0-9-]{36}$/;
const CSV_PREVIEW_BYTES = 256 * 1024;

// Count logical CSV records, including quoted multiline values. A bounded
// preview must never turn a truncated or malformed file into an empty table.
function csvInfo(file, size) {
  const fd = fs.openSync(file, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(Math.min(size, CSV_PREVIEW_BYTES));
    buffer = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
  } finally { fs.closeSync(fd); }
  const full = buffer.length === size;
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  let quoted = false, hasValue = false, records = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      hasValue = true;
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (hasValue) records++;
      hasValue = false;
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else if (!/\s/.test(ch)) hasValue = true;
  }
  if (full && !quoted) {
    if (hasValue) records++;
    return { rowCount: Math.max(0, records - 1), empty: records <= 1 };
  }
  return { rowCount: null, empty: records > 1 ? false : null };
}

function presentation(name) {
  const base = path.basename(name).replace(/^[a-f0-9]{8}-/, '');
  if (/\.(?:py|r|jl|m|ipynb|js|sh|bat|ps1)$/i.test(base)) return { category: 'auxiliary', label: '处理代码' };
  if (/field[_ -]?dictionary|字段|字典/i.test(base)) return { category: 'auxiliary', label: '字段说明' };
  if (/entity[_ -]?screening/i.test(base)) return { category: 'auxiliary', label: '国家与地区初筛明细' };
  if (/mirror[_ -]?differences/i.test(base)) return { category: 'auxiliary', label: '进出口对照明细（含一致记录）' };
  if (/check[_ -]?report|validation[_ -]?report|检查报告|核查报告/i.test(base)) return { category: 'reports', label: '检查报告' };
  if (/unilateral|单边/i.test(base)) return { category: 'issues', label: '单边记录 · 待讨论处理' };
  if (/duplicate[_ -]?keys|重复/i.test(base)) return { category: 'issues', label: '重复记录检查' };
  if (/aggregate[_ -]?candidates|汇总候选/i.test(base)) return { category: 'issues', label: '区域与汇总候选检查' };
  if (/unresolved[_ -]?rows|unresolved|invalid[_ -]?rows|异常|歧义/i.test(base)) return { category: 'issues', label: '异常或待确认记录' };
  if (/unified[_ -]?trade/i.test(base)) return { category: 'main', label: '统一贸易表' };
  if (/import.*(?:ratio|share|proportion)|(?:ratio|share|proportion).*import|进口.*比例/i.test(base)) return { category: 'main', label: '进口来源比例' };
  if (/export.*(?:ratio|share|proportion)|(?:ratio|share|proportion).*export|出口.*比例/i.test(base)) return { category: 'main', label: '出口去向比例' };
  if (/\.(?:csv|tsv|xlsx|xls|parquet|json)$/i.test(base)) return { category: 'main', label: '结果数据' };
  return { category: 'auxiliary', label: '其他说明与运行材料' };
}

function cleanResultsView(bridge, sessionId, runId) {
  bridge.session(sessionId);
  if (runId && !ID.test(runId)) throw new Error('无效结果运行标识');
  const files = bridge.files(sessionId);
  const runs = new Map();
  const inputs = [], otherFiles = [];
  for (const file of files) {
    const descriptor = { ...file };
    if (file.group === 'input') { inputs.push({ ...descriptor, label: '原始文件' }); continue; }
    if (file.group !== 'output') { otherFiles.push({ ...descriptor, label: '参考材料' }); continue; }
    const parts = file.name.split('/');
    if (parts.some(part => part.startsWith('.')) || path.basename(file.name) === 'run-state.json') continue;
    const id = parts[0];
    if (!ID.test(id) || parts.length < 2) { otherFiles.push({ ...descriptor, label: '其他输出文件' }); continue; }
    const source = bridge.download(sessionId, 'output', file.name);
    const stat = fs.statSync(source);
    if (!runs.has(id)) runs.set(id, { id, updatedAt: stat.mtimeMs, files: [] });
    const run = runs.get(id);
    run.updatedAt = Math.max(run.updatedAt, stat.mtimeMs);
    run.files.push(descriptor);
  }
  const ordered = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (runId && !runs.has(runId)) throw new Error('未找到这次清洗结果，请刷新文件后重试');
  const selected = runId ? runs.get(runId) : ordered[0];
  const groups = { main: [], reports: [], issues: [], auxiliary: [] };
  for (const file of selected?.files || []) {
    const { category, label } = presentation(file.name);
    const descriptor = { ...file, label };
    if (/\.csv$/i.test(file.name)) Object.assign(descriptor, csvInfo(bridge.download(sessionId, 'output', file.name), file.size));
    const emptyIssue = category === 'issues' && descriptor.empty === true;
    if (emptyIssue) descriptor.label = label + ' · 无记录的检查清单';
    groups[emptyIssue ? 'auxiliary' : category].push(descriptor);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => a.name.localeCompare(b.name));
  return {
    sessionId, runId: selected?.id || null,
    runs: ordered.map(run => ({ id: run.id, updatedAt: new Date(run.updatedAt).toISOString(), fileCount: run.files.length })),
    groups, inputs, otherFiles
  };
}

module.exports = { cleanResultsView, presentation, csvInfo, CSV_PREVIEW_BYTES };
