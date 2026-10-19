'use strict';

// 运行配置归一（第一阶段 12 字段行为逐字保留；v2 可选字段见设计 §3.1）。
const { isKnown, assertExecutable } = require('./literature-sources');

const DEFAULT_LIMITS = { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800, validate: 300, export: 600 };

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

function object(value, name) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须是对象`);
  return value;
}

function integer(value, name, min, max) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name}必须为 ${min}–${max} 的整数`);
  return result;
}

function batchConfig(raw, limit) {
  const value = object(raw, '批配置');
  const size = value.size == null ? limit : integer(value.size, '每批检索数量', 1, 10);
  const maxBatches = value.maxBatches == null ? 1 : integer(value.maxBatches, '批数上限', 1, 50);
  return { size, maxBatches };
}

function fieldDefinitions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw new Error('字段定义必须是列表且不超过 50 项');
  const seen = new Set();
  return raw.map((item, index) => {
    const label = `第 ${index + 1} 个字段定义`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}必须是对象`);
    const key = string(item.key, `${label}的 key`, 100);
    if (!key) throw new Error(`${label}缺少 key`);
    if (seen.has(key)) throw new Error(`字段定义 key 重复：${key}`);
    seen.add(key);
    const definition = {
      key,
      label: string(item.label, `${label}的 label`, 200) || key,
      meaning: string(item.meaning, `${label}的 meaning`, 500),
      unit: string(item.unit, `${label}的 unit`, 100),
      valueType: string(item.valueType, `${label}的 valueType`, 50) || 'string',
      required: item.required === true
    };
    if (item.allowedRange != null) {
      const range = object(item.allowedRange, `${label}的 allowedRange`);
      const min = range.min == null ? null : Number(range.min);
      const max = range.max == null ? null : Number(range.max);
      if ((min === null && max === null) || (min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) throw new Error(`${label}的 allowedRange 无效`);
      if (min !== null && max !== null && min > max) throw new Error(`${label}的 allowedRange 起点不能大于终点`);
      definition.allowedRange = { min, max };
    }
    if (item.allowedValues != null) {
      if (!Array.isArray(item.allowedValues) || item.allowedValues.length > 100) throw new Error(`${label}的 allowedValues 必须是列表且不超过 100 项`);
      definition.allowedValues = item.allowedValues.filter(entry => ['string', 'number', 'boolean'].includes(typeof entry));
    }
    if (item.conditionKeys != null) definition.conditionKeys = list(item.conditionKeys, `${label}的 conditionKeys`);
    return definition;
  });
}

function templatePath(value, name) {
  const text = string(value, name, 400);
  if (!text) return null;
  if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.startsWith('\\') || text.split(/[\\/]+/).includes('..')) {
    throw new Error(`${name}必须是项目内相对路径`);
  }
  return text;
}

function fulltextConfig(raw) {
  const value = object(raw, '全文配置');
  const maxPapers = value.maxPapers == null ? 0 : integer(value.maxPapers, '全文获取上限', 0, 10000);
  const perPaperTimeoutSec = value.perPaperTimeoutSec == null ? 120 : integer(value.perPaperTimeoutSec, '单篇全文获取超时', 1, 3600);
  return { maxPapers, perPaperTimeoutSec };
}

function extractionConfig(raw) {
  const value = object(raw, '提取配置');
  const maxCharsPerPaper = value.maxCharsPerPaper == null ? 120000 : integer(value.maxCharsPerPaper, '单篇提取字符上限', 1000, 1000000);
  const model = string(value.model, '提取模型', 100) || null;
  return { maxCharsPerPaper, model };
}

function limitsConfig(raw) {
  const value = object(raw, '阶段超时');
  const result = { ...DEFAULT_LIMITS };
  for (const stage of Object.keys(DEFAULT_LIMITS)) {
    if (value[stage] == null) continue;
    result[stage] = integer(value[stage], `${stage} 阶段超时`, 1, 86400);
  }
  return result;
}

function normalizeConfig(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运行配置必须是对象');
  const topic = string(raw.topic, '研究主题');
  const query = string(raw.query, '检索式');
  if (!topic || !query) throw new Error('请填写研究主题和 Google Scholar 检索式');
  const sources = list(raw.sources, '检索来源', 10).map(value => value.toLowerCase());
  if (!sources.length || sources.some(value => !isKnown(value)) || new Set(sources).size !== sources.length) throw new Error('检索来源为空、重复或不受识别');
  if (options.executable) assertExecutable(sources);
  const publicationYearFrom = year(raw.publicationYearFrom, '发表起始年份');
  const publicationYearTo = year(raw.publicationYearTo, '发表截止年份');
  if (publicationYearFrom && publicationYearTo && publicationYearFrom > publicationYearTo) throw new Error('发表起始年份不能晚于截止年份');
  const limit = raw.limit == null ? 10 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('首批检索数量必须为 1–10');
  const templates = object(raw.templates, '模板配置');
  return {
    version: 2, topic, query, sources,
    publicationYearFrom, publicationYearTo,
    geography: string(raw.geography, '地域', 200),
    language: string(raw.language, '语言', 100),
    studyTypes: list(raw.studyTypes, '研究类型'),
    inclusion: list(raw.inclusion, '纳入规则'),
    exclusion: list(raw.exclusion, '排除规则'),
    targetFields: list(raw.targetFields, '目标字段'),
    limit,
    batch: batchConfig(raw.batch, limit),
    fieldDefinitions: fieldDefinitions(raw.fieldDefinitions),
    templates: { literature: templatePath(templates.literature, '文献模板'), parameters: templatePath(templates.parameters, '参数模板') },
    fulltext: fulltextConfig(raw.fulltext),
    extraction: extractionConfig(raw.extraction),
    limits: limitsConfig(raw.limits)
  };
}

module.exports = { normalizeConfig, DEFAULT_LIMITS };
