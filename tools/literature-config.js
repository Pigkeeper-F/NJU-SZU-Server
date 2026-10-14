'use strict';

const SUPPORTED_SOURCE = 'google-scholar';
const KNOWN_SOURCES = new Set([SUPPORTED_SOURCE, 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed']);

function string(value, name, max = 500) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name}格式不正确或过长`);
  return value.trim();
}

function list(value, name, maxItems = 30) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name}必须是列表`);
  return value.map(item => string(item, name, 500)).filter(Boolean);
}

function year(value, name) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1800 || result > new Date().getUTCFullYear() + 1) throw new Error(`${name}无效`);
  return result;
}

function normalizeConfig(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运行配置必须是对象');
  const topic = string(raw.topic, '研究主题');
  const query = string(raw.query, '检索式');
  if (!topic || !query) throw new Error('请填写研究主题和 Google Scholar 检索式');
  const sources = list(raw.sources, '检索来源', 10).map(value => value.toLowerCase());
  if (!sources.length || sources.some(value => !KNOWN_SOURCES.has(value)) || new Set(sources).size !== sources.length) throw new Error('检索来源为空、重复或不受识别');
  if (options.executable) {
    const unavailable = sources.filter(source => source !== SUPPORTED_SOURCE);
    if (unavailable.length) throw new Error(`尚未接通以下检索来源：${unavailable.join('、')}；请明确改为仅检索 Google Scholar，或等待相应连接器。`);
  }
  const publicationYearFrom = year(raw.publicationYearFrom, '发表起始年份');
  const publicationYearTo = year(raw.publicationYearTo, '发表截止年份');
  if (publicationYearFrom && publicationYearTo && publicationYearFrom > publicationYearTo) throw new Error('发表起始年份不能晚于截止年份');
  const limit = raw.limit == null ? 10 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('首批检索数量必须为 1–10');
  return {
    version: 1, topic, query, sources,
    publicationYearFrom, publicationYearTo,
    geography: string(raw.geography, '地域', 200),
    language: string(raw.language, '语言', 100),
    studyTypes: list(raw.studyTypes, '研究类型'),
    inclusion: list(raw.inclusion, '纳入规则'),
    exclusion: list(raw.exclusion, '排除规则'),
    targetFields: list(raw.targetFields, '目标字段'),
    limit
  };
}

module.exports = { normalizeConfig };
