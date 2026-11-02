'use strict';

// 运行配置归一（第一阶段 12 字段行为逐字保留；v2 可选字段见设计 §3.1）。
const { isKnown, assertExecutable } = require('./literature-sources');

const DEFAULT_LIMITS = { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800, validate: 300, export: 600 };
// A grouped legacy draft may expand to many individual variables. Keep the
// same bound across configuration, discussion and the confirmation checkpoint.
const MAX_FIELD_DEFINITIONS = 200;
const MAX_RULES = 200;
const MAX_RULE_CHARS = 2000;
// Search expressions are deliberately larger than individual prose rules.
// Keep this contract aligned with the visible input and Python entry points.
const MAX_QUERY_CHARS = 32768;

function string(value, name, max = 500) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name}格式不正确或过长`);
  return value.trim();
}

function list(value, name, maxItems = 30, maxChars = 500) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name}必须是列表；请保留原内容并在检索设置中按条目整理`);
  if (value.length > maxItems) throw new Error(`${name}共有${value.length}项，超过${maxItems}项上限；内容未删除，请整理后重试`);
  return value.map((item, index) => {
    const label = `${name}第${index + 1}项`;
    if (typeof item === 'string' && item.length > maxChars) throw new Error(`${label}共${item.length}字，超过${maxChars}字上限；原内容保留，未自动截断`);
    return string(item, label, maxChars);
  }).filter(Boolean);
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

function batchConfig(raw, limit, fixedSize = false) {
  const value = object(raw, '批配置');
  const size = fixedSize ? 10 : value.size == null ? limit : integer(value.size, '每批检索数量', 1, 10);
  const maxBatches = value.maxBatches == null ? 1 : integer(value.maxBatches, '批数上限', 1, 50);
  return { size, maxBatches };
}

// 按来源覆盖检索式（可选）：各源语法不通用，PubMed 的字段标签不能直接喂 OpenAlex。
// 未列出的来源继续用顶层 query；旧配置（没有 sourceQueries）行为完全不变。
function sourceQueries(raw) {
  const value = object(raw, '分来源检索式');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isKnown(key)) throw new Error(`分来源检索式包含未知来源：${key}`);
    const query = queryText(entry, `${key} 检索式`);
    if (!query) throw new Error(`${key} 检索式不能为空`);
    result[key] = query;
  }
  return result;
}

function queryText(value, name) {
  if (typeof value === 'string' && value.length > MAX_QUERY_CHARS) {
    throw new Error(`${name}共${value.length}字，超过${MAX_QUERY_CHARS}字上限；原检索式保留，未自动截断`);
  }
  return string(value, name, MAX_QUERY_CHARS);
}

// Optional so legacy frozen configurations retain exactly their old shape.
function scholarPlanConfig(raw, sources) {
  if (raw == null) return undefined;
  const value = object(raw, '谷歌学术分批计划');
  if (Object.keys(value).some(key => !['version', 'topics', 'yearSpan', 'sort', 'trialMaxPages'].includes(key))) throw new Error('谷歌学术分批计划包含未知字段');
  if (!sources.includes('google-scholar')) throw new Error('谷歌学术分批计划需要选择谷歌学术来源');
  // Frozen v1 plans retain their five-year windows; v2 explicitly starts each
  // topic over the full configured period and splits only on a result cap.
  if (!((value.version === 1 && value.yearSpan === 5) || (value.version === 2 && value.yearSpan === 0)) || value.sort !== 'relevance') throw new Error('谷歌学术计划须为版本1/yearSpan=5或版本2/yearSpan=0（整段优先），并按相关性排序');
  if (!Array.isArray(value.topics) || value.topics.length < 1 || value.topics.length > 256) throw new Error('谷歌学术主题须为1–256项');
  const seen = new Set();
  const topics = value.topics.map(rawTopic => {
    const topic = object(rawTopic, '谷歌学术主题');
    if (Object.keys(topic).some(key => !['id', 'label', 'query', 'refinementQueries'].includes(key))) throw new Error('谷歌学术主题包含未知字段');
    const id = string(topic.id, '谷歌学术主题编号', 80), label = string(topic.label, '谷歌学术主题名称', 200) || id;
    const query = queryText(topic.query, '谷歌学术主题检索式');
    if (!id || !label || !query || seen.has(id)) throw new Error('谷歌学术主题编号、名称和检索式不能为空，编号不能重复');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error('谷歌学术主题编号仅可包含英文字母、数字、下划线和短横线，并以字母或数字开头');
    seen.add(id);
    let refinementQueries;
    if (topic.refinementQueries != null) {
      if (!Array.isArray(topic.refinementQueries) || topic.refinementQueries.length > 32) throw new Error('谷歌学术预定细分检索式最多32项');
      refinementQueries = topic.refinementQueries.map(entry => {
        const text = queryText(entry, '谷歌学术细分检索式');
        if (!text) throw new Error('谷歌学术细分检索式不能为空');
        return text;
      });
      if (new Set(refinementQueries).size !== refinementQueries.length || refinementQueries.includes(query)) throw new Error('谷歌学术细分检索式不能重复或与主查询相同');
    }
    return { id, label, query, ...(refinementQueries ? { refinementQueries } : {}) };
  });
  let trialMaxPages;
  if (value.trialMaxPages != null) {
    if (typeof value.trialMaxPages === 'boolean') throw new Error('谷歌学术预试页数必须为1–100的整数');
    trialMaxPages = integer(value.trialMaxPages, '谷歌学术预试页数', 1, 100);
    if (sources.length !== 1) throw new Error('谷歌学术预试只能使用谷歌学术来源');
  }
  return { version: value.version, topics, yearSpan: value.yearSpan, sort: 'relevance', ...(trialMaxPages == null ? {} : { trialMaxPages }) };
}

function fieldDefinitions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FIELD_DEFINITIONS) throw new Error(`字段定义必须是列表且不超过 ${MAX_FIELD_DEFINITIONS} 项`);
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

function discoverBudget(config) {
  if (config?.searchMode === 'formal' && config.stopMode === 'end') return 86400;
  const sourceCount = Array.isArray(config?.sources) ? config.sources.length : 1;
  const target = config?.searchMode === 'formal'
    ? (Number.isInteger(config.perSourceLimit) && config.perSourceLimit >= 1 && config.perSourceLimit <= 1000 ? config.perSourceLimit : 100)
    : 10;
  return Math.min(86400, 180 * Math.min(6, Math.max(1, sourceCount)) * Math.ceil(target / 10));
}

function limitsConfig(raw, config) {
  const value = object(raw, '阶段超时');
  const result = { ...DEFAULT_LIMITS };
  result.discover = discoverBudget(config);
  for (const stage of Object.keys(DEFAULT_LIMITS)) {
    if (value[stage] == null) continue;
    result[stage] = integer(value[stage], `${stage} 阶段超时`, 1, 86400);
  }
  return result;
}

function normalizeConfig(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运行配置必须是对象');
  const topic = string(raw.topic, '研究主题');
  const query = queryText(raw.query, '检索式');
  if (!topic || !query) throw new Error('请填写研究主题和默认检索式');
  const sources = list(raw.sources, '检索来源', 10).map(value => value.toLowerCase());
  if (!sources.length || sources.some(value => !isKnown(value)) || new Set(sources).size !== sources.length) throw new Error('检索来源为空、重复或不受识别');
  if (options.executable) assertExecutable(sources);
  const publicationYearFrom = year(raw.publicationYearFrom, '发表起始年份');
  const publicationYearTo = year(raw.publicationYearTo, '发表截止年份');
  if (publicationYearFrom && publicationYearTo && publicationYearFrom > publicationYearTo) throw new Error('发表起始年份不能晚于截止年份');
  const searchMode = raw.searchMode == null ? null : string(raw.searchMode, '检索模式', 20);
  if (searchMode !== null && !['test', 'formal'].includes(searchMode)) throw new Error('检索模式必须是 test 或 formal');
  const stopMode = raw.stopMode == null ? null : string(raw.stopMode, '检索停止方式', 20);
  if (stopMode !== null && !['count', 'end'].includes(stopMode)) throw new Error('检索停止方式必须是 count 或 end');
  if (stopMode === 'end' && searchMode !== 'formal') throw new Error('检索到末页只适用于正式模式');
  let perSourceLimit = 10;
  if (searchMode === 'formal' && stopMode === 'end') {
    perSourceLimit = null;
  } else if (searchMode === 'formal') {
    if (typeof raw.perSourceLimit === 'boolean') throw new Error('每来源检索数量必须为 1–1000 的整数');
    perSourceLimit = raw.perSourceLimit == null ? 100 : integer(raw.perSourceLimit, '每来源检索数量', 1, 1000);
  }
  const limit = searchMode ? 10 : raw.limit == null ? 10 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('首批检索数量必须为 1–10');
  const templates = object(raw.templates, '模板配置');
  const scholarPlan = scholarPlanConfig(raw.scholarPlan, sources);
  let screeningPolicy, researchPlan;
  if (raw.screeningPolicy != null) {
    const value = object(raw.screeningPolicy, '篇关摘规则');
    screeningPolicy = { id: string(value.id, '规则编号', 160), line: string(value.line, '研究线', 30), text: string(value.text, '规则内容', 200000) };
    if (!screeningPolicy.id || !screeningPolicy.text || !['production', 'emission'].includes(screeningPolicy.line)) throw new Error('篇关摘规则须有编号、完整内容及 production/emission 研究线');
  }
  if (raw.researchPlan != null) {
    const value = object(raw.researchPlan, '已确认方案');
    researchPlan = { id: string(value.id, '方案编号', 160), presetId: string(value.presetId, '来源方案编号', 160),
      boundDate: string(value.boundDate, '执行配置日期', 10), bundleHash: string(value.bundleHash, '方案指纹', 64) };
    if (!screeningPolicy || !researchPlan.id || !researchPlan.presetId || !/^\d{4}-\d{2}-\d{2}$/.test(researchPlan.boundDate) || !/^[a-f0-9]{64}$/.test(researchPlan.bundleHash)) throw new Error('已确认方案缺少规则或版本依据');
    if (value.role != null) {
      if (!['primary', 'supplement'].includes(value.role)) throw new Error('检索任务类型无效');
      researchPlan.role = value.role;
    }
    if (value.parentPresetId != null) researchPlan.parentPresetId = string(value.parentPresetId, '主检索方案编号', 160);
  }
  if (scholarPlan && (searchMode !== 'formal' || stopMode !== 'end')) throw new Error('谷歌学术分批计划须使用 formal/end 分页模式；预试仍由独立页数上限停止');
  return {
    version: 2, topic, query, sources,
    publicationYearFrom, publicationYearTo,
    geography: string(raw.geography, '地域', 200),
    language: string(raw.language, '语言', 100),
    studyTypes: list(raw.studyTypes, '研究类型'),
    inclusion: list(raw.inclusion, '纳入规则', MAX_RULES, MAX_RULE_CHARS),
    exclusion: list(raw.exclusion, '排除规则', MAX_RULES, MAX_RULE_CHARS),
    targetFields: list(raw.targetFields, '目标字段', MAX_FIELD_DEFINITIONS),
    limit,
    ...(searchMode ? { searchMode, perSourceLimit, ...(stopMode ? { stopMode } : {}) } : {}),
    sourceQueries: sourceQueries(raw.sourceQueries),
    ...(screeningPolicy ? { screeningPolicy } : {}),
    ...(researchPlan ? { researchPlan } : {}),
    ...(scholarPlan ? { scholarPlan } : {}),
    batch: batchConfig(raw.batch, limit, !!searchMode),
    fieldDefinitions: fieldDefinitions(raw.fieldDefinitions),
    templates: { literature: templatePath(templates.literature, '文献模板'), parameters: templatePath(templates.parameters, '参数模板') },
    fulltext: fulltextConfig(raw.fulltext),
    extraction: extractionConfig(raw.extraction),
    limits: limitsConfig(raw.limits, { sources, searchMode, perSourceLimit, stopMode })
  };
}

module.exports = { normalizeConfig, DEFAULT_LIMITS, MAX_FIELD_DEFINITIONS, MAX_RULES, MAX_RULE_CHARS, MAX_QUERY_CHARS, discoverBudget };
