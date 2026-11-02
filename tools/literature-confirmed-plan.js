'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeConfig } = require('./literature-config');
const screening = require('./literature-screening');

function catalog(root) {
  const bytes = fs.readFileSync(path.join(root, 'config', 'confirmed-climate-research.json'));
  const data = JSON.parse(bytes);
  if (!Array.isArray(data.entries) || data.entries.length !== 10) throw new Error('五库已确认方案不完整');
  return { ...data, bundleHash: createHash('sha256').update(bytes).digest('hex') };
}

function buildConfig(root, presetId, date = new Date()) {
  const data = catalog(root), entry = [...data.entries, ...(data.followups || [])].find(item => item.id === presetId);
  if (!entry) throw new Error('请选择已确认的数据库与研究线');
  const boundDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const year = Number(boundDate.slice(0, 4));
  let query = entry.query || entry.queries[0]?.query;
  if (entry.source === 'web-of-science') query = query.replace(/DOP=2000-01-01\/\d{4}-\d{2}-\d{2}/g, 'DOP=2000-01-01/' + boundDate);
  if (entry.source === 'scopus') query = query.replace(/PUBYEAR BEF \d{4}/g, 'PUBYEAR BEF ' + (year + 1));
  const config = normalizeConfig({ topic: '气候变化对畜禽和养殖水产的影响 · ' + entry.label,
    query, sourceQueries: { [entry.source]: query }, sources: [entry.source],
    publicationYearFrom: 2000, publicationYearTo: year, language: '中文、English',
    searchMode: 'formal', stopMode: 'end', perSourceLimit: null,
    inclusion: ['按本任务绑定的已确认篇关摘规则逐篇判断；普通候选获取全文。', '资格不清也获取PDF，独立待定区由研究者选择，默认不提取。'],
    exclusion: ['只有原文证据明确不符且无其他合格部分才排除；获取失败不等于科学排除。'],
    screeningPolicy: entry.screeningPolicy,
    researchPlan: { id: data.id, presetId, boundDate, bundleHash: data.bundleHash,
      ...(entry.role === 'supplement' ? { role: 'supplement', parentPresetId: entry.parentPresetId } : {}) },
    ...(entry.queries.length ? { scholarPlan: { version: 2, yearSpan: 0, sort: 'relevance',
      topics: entry.queries.map(({id, label, query, refinementQueries}) => ({id, label, query, ...(refinementQueries ? {refinementQueries} : {})})) } } : {}),
    fulltext: { maxPapers: 0, perPaperTimeoutSec: 120 }
  }, { executable: true });
  return { config, basis: { schemaVersion: 1, authorization: data.authorization, bundleHash: data.bundleHash,
    presetId, boundDate, queryRef: entry.queryRef, provenance: entry.provenance, historicalCount: entry.reportedCount,
    note: '创建仅准备配置；源端条件、实际执行日和覆盖在运行时核验。历史数量不作为停止目标。', entry } };
}

function readOptional(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }

function screeningView(job) {
  const state = readOptional(path.join(job.dir, 'screening', 'status.json'), { records: {} });
  const fulltext = readOptional(path.join(job.dir, 'fulltext', 'status.json'), { items: [] });
  const context = screening.policyIdentity(job.config.screeningPolicy);
  let bundles = [];
  try { bundles = screening.loadInputs(job.dir); } catch (error) { return { records: [], counts: {}, message: error.message }; }
  const counts = { include: 0, pending: 0, exclude: 0, unscreened: 0 };
  const records = bundles.map(bundle => {
    const valid = screening.validStored(state.records[bundle.paper_id], bundle, job.config.screeningPolicy, job.dir);
    const items = fulltext.items.filter(row => row.paper_id === bundle.paper_id);
    const item = items.find(row => row.status === 'fetched_pdf') || items.at(-1);
    const decision = valid?.decision || 'unscreened'; counts[decision]++;
    return { paperId: bundle.paper_id, title: bundle.documents[0]?.title || bundle.paper_id, decision,
      reason: valid?.reason || '尚无当前规则及题录版本下的有效判定', inputHash: screening.digest(bundle), policyHash: context?.policyHash,
      evidence: valid?.evidence || [], uncertainties: valid?.uncertainties || [],
      pdfPath: item?.status === 'fetched_pdf' ? item.pdf_path || item.path || null : null, materialStatus: item?.status || 'not_acquired',
      extractionAllowed: valid?.extraction_allowed === true, requiresFulltextEligibility: valid?.requires_fulltext_eligibility === true };
  });
  return { records, counts, policy: context, message: state.last_error?.message || '' };
}

module.exports = { catalog, buildConfig, screeningView };
