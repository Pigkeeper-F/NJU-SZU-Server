'use strict';

// 来源注册表 + 运行配置归一（v2 可选字段）测试。运行：node tools/test-literature-sources.js

const assert = require('node:assert/strict');
const { SOURCES, listSources, isKnown, stateOf, executableSources, assertExecutable } = require('./literature-sources');
const { normalizeConfig, DEFAULT_LIMITS } = require('./literature-config');

const base = { topic: '气候变化与养殖', query: 'climate change aquaculture China', sources: ['google-scholar'], publicationYearFrom: 2000, publicationYearTo: 2026,
  geography: '中国', language: '', studyTypes: ['原始研究'], inclusion: [], exclusion: [], targetFields: ['产量'], limit: 10 };

function main() {
  // 注册表：不写死完整顺序（来源会随接入进展增加），只断言不变量。
  assert.deepEqual(SOURCES.map(item => item.key).slice(0, 6),
    ['google-scholar', 'pubmed', 'pmc', 'openalex', 'semantic-scholar', 'europe-pmc'],
    '可执行来源排在前，人工来源在后');
  assert.deepEqual(executableSources().map(item => item.key).sort(),
    ['europe-pmc', 'google-scholar', 'openalex', 'pmc', 'pubmed', 'semantic-scholar'].sort());
  for (const source of SOURCES) {
    assert.ok(source.label, '每个来源都有显示名：' + source.key);
    assert.ok(source.idPrefix, '每个来源都有候选 id 前缀：' + source.key);
    assert.ok(['executable', 'registered'].includes(source.state), 'state 合法：' + source.key);
  }
  assert.equal(SOURCES[0].adapter.kind, 'soc-script');
  assert.ok(SOURCES[0].adapter.script.endsWith('google_scholar_search.py'));
  assert.equal(stateOf('google-scholar'), 'executable');
  assert.equal(stateOf('pubmed'), 'executable');
  assert.equal(stateOf('openalex'), 'executable');
  assert.equal(stateOf('cnki'), 'registered');
  assert.equal(stateOf('arxiv'), null);
  assert.ok(isKnown('pubmed'));
  assert.ok(!isKnown('arxiv'));
  assert.deepEqual(listSources(), SOURCES);
  const copy = listSources();
  copy[0].state = 'mutated';
  assert.equal(SOURCES[0].state, 'executable', 'listSources 必须返回副本');

  // 双层防线：拒绝文案逐字保持（设计 §7/§10）
  assert.equal(assertExecutable(['google-scholar']), true);
  assert.equal(assertExecutable(['google-scholar', 'pubmed', 'openalex']), true);
  assert.throws(() => assertExecutable(['cnki', 'wanfang']),
    error => error.message.startsWith('尚未接通以下检索来源：cnki、wanfang；请明确改为仅检索 Google Scholar，或等待相应连接器。'));

  // normalizeConfig：12 字段校验文案不回归 + v2 可选字段
  assert.throws(() => normalizeConfig({ ...base, topic: '' }), /请填写研究主题和 Google Scholar 检索式/);
  assert.throws(() => normalizeConfig({ ...base, sources: [] }), /检索来源为空、重复或不受识别/);
  assert.throws(() => normalizeConfig({ ...base, sources: ['google-scholar', 'google-scholar'] }), /检索来源为空、重复或不受识别/);
  assert.throws(() => normalizeConfig({ ...base, sources: ['arxiv'] }), /检索来源为空、重复或不受识别/);
  assert.throws(() => normalizeConfig({ ...base, limit: 11 }), /首批检索数量必须为 1–10/);
  assert.throws(() => normalizeConfig({ ...base, publicationYearFrom: 1800 - 1 }), /发表起始年份无效/);
  assert.throws(() => normalizeConfig({ ...base, publicationYearFrom: 2026, publicationYearTo: 2000 }), /不能晚于/);
  assert.throws(() => normalizeConfig({ ...base, sources: ['google-scholar', 'scopus'] }, { executable: true }), /尚未接通以下检索来源：scopus/);
  assert.deepEqual(normalizeConfig({ ...base, sources: ['google-scholar', 'scopus'] }).sources, ['google-scholar', 'scopus'], '非 executable 模式保持登记语义');

  const normalized = normalizeConfig(base);
  assert.equal(normalized.version, 2);
  assert.deepEqual(Object.keys(normalized).slice(0, 5), ['version', 'topic', 'query', 'sources', 'sourceQueries']);
  assert.deepEqual(normalized.sourceQueries, {}, '旧配置没有按源检索式时为空对象，行为不变');
  assert.deepEqual(
    normalizeConfig({ ...base, sources: ['google-scholar', 'pubmed'], sourceQueries: { pubmed: '"soil organic carbon"[Title/Abstract]' } }).sourceQueries,
    { pubmed: '"soil organic carbon"[Title/Abstract]' });
  assert.throws(() => normalizeConfig({ ...base, sourceQueries: { pubmed: 'x' } }), /未启用的来源/);
  assert.throws(() => normalizeConfig({ ...base, sources: ['pubmed'], sourceQueries: { pubmed: '   ' } }), /检索式为空/);
  assert.throws(() => normalizeConfig({ ...base, sourceQueries: 'pubmed=x' }), /按源检索式必须是对象/);

  // v2 缺省值（设计 §3.1：缺省时行为与 v1 逐字一致）
  assert.deepEqual(normalized.batch, { size: 10, maxBatches: 1 });
  assert.deepEqual(normalized.fieldDefinitions, []);
  assert.deepEqual(normalized.templates, { literature: null, parameters: null });
  assert.deepEqual(normalized.fulltext, { maxPapers: 0, perPaperTimeoutSec: 120 });
  assert.deepEqual(normalized.extraction, { maxCharsPerPaper: 120000, model: null });
  assert.deepEqual(normalized.limits, DEFAULT_LIMITS);
  assert.deepEqual(DEFAULT_LIMITS, { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800, validate: 300, export: 600 });

  assert.deepEqual(normalizeConfig({ ...base, batch: { size: 5, maxBatches: 3 } }).batch, { size: 5, maxBatches: 3 });
  assert.throws(() => normalizeConfig({ ...base, batch: { maxBatches: 51 } }), /批数上限/);
  assert.throws(() => normalizeConfig({ ...base, batch: { size: 0 } }), /每批检索数量/);
  assert.throws(() => normalizeConfig({ ...base, batch: 3 }), /批配置必须是对象/);
  assert.throws(() => normalizeConfig({ ...base, templates: { literature: 'C:\\x.xlsx' } }), /项目内相对路径/);
  assert.throws(() => normalizeConfig({ ...base, templates: { parameters: '../out.xlsx' } }), /项目内相对路径/);
  assert.deepEqual(normalizeConfig({ ...base, templates: { literature: 'templates/lit.xlsx' } }).templates,
    { literature: 'templates/lit.xlsx', parameters: null });
  assert.throws(() => normalizeConfig({ ...base, limits: { dedupe: 0 } }), /dedupe 阶段超时/);
  assert.equal(normalizeConfig({ ...base, limits: { fulltext: 7200 } }).limits.fulltext, 7200);
  assert.equal(normalizeConfig({ ...base, fulltext: { maxPapers: 50 } }).fulltext.maxPapers, 50);
  assert.throws(() => normalizeConfig({ ...base, fulltext: { perPaperTimeoutSec: 0 } }), /单篇全文获取超时/);
  assert.equal(normalizeConfig({ ...base, extraction: { model: 'gpt-6-luna' } }).extraction.model, 'gpt-6-luna');

  const definition = { key: 'soc', label: 'SOC', meaning: '土壤有机碳含量', unit: 'g/kg', valueType: 'number', required: true,
    allowedRange: { min: 0, max: 600 }, conditionKeys: ['site', 'year'] };
  assert.deepEqual(normalizeConfig({ ...base, fieldDefinitions: [definition] }).fieldDefinitions, [definition]);
  assert.throws(() => normalizeConfig({ ...base, fieldDefinitions: [{ key: 'soc', allowedRange: { min: 5, max: 1 } }] }), /起点不能大于终点/);
  assert.throws(() => normalizeConfig({ ...base, fieldDefinitions: [{ key: 'a' }, { key: 'a' }] }), /key 重复/);
  assert.throws(() => normalizeConfig({ ...base, fieldDefinitions: [{ label: 'x' }] }), /缺少 key/);
  assert.throws(() => normalizeConfig({ ...base, fieldDefinitions: 'soc' }), /字段定义必须是列表/);

  console.log('LITERATURE_SOURCES_TESTS_PASS');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
