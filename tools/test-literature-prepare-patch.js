#!/usr/bin/env node
'use strict';
// Production parser with inert model-output fixtures. No model/task/search runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { PREPARE_INSTRUCTIONS } = require('./literature-prepare');
const source = fs.readFileSync(path.join(__dirname, '..', 'js/codex.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  const LITERATURE_CONFIG_KEYS'), source.indexOf('  async function prepareLiterature(')), context);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function base() {
  return { version: 2, topic: 'Climate effects on livestock and farmed fish/shrimp', query: 'old animal AND exposure query',
    sources: ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus'],
    sourceQueries: { 'google-scholar': 'old scholar query', cnki: '原中文式', wanfang: '原万方式', 'web-of-science': 'old WOS query', scopus: 'old Scopus query' },
    publicationYearFrom: 2000, publicationYearTo: 2026, geography: 'global', language: 'Chinese and English',
    studyTypes: ['journal', 'thesis'], inclusion: ['separable target climate influence'], exclusion: ['animal respiration CO2'],
    targetFields: ['growth', 'milk', 'eggs', 'CH4'], fieldDefinitions: [{ key: 'growth', meaning: 'reported growth', valueType: 'number', unit: 'g/day' }],
    templates: { literature: 'templates/user-literature.xlsx', parameters: 'templates/user-parameters.xlsx' },
    searchMode: 'formal', stopMode: 'end', perSourceLimit: null, limit: 10,
    batch: { size: 10, maxBatches: 2 }, fulltext: { maxPapers: 0, perPaperTimeoutSec: 120 },
    extraction: { model: 'fixture-model', maxCharsPerPaper: 120000 }, limits: { discover: 86400, dedupe: 120, fulltext: 3600 } };
}
function parse(patch, baseline = base()) {
  let notice = ''; const original = JSON.stringify(baseline);
  const result = context.parseLiteratureConfig(JSON.stringify(patch), { baseline, onFormatNotice: value => { notice = value; } });
  assert.equal(JSON.stringify(baseline), original, 'Parser never mutates the baseline or its confirmation state');
  return { result: copy(result), notice };
}
test('user scenario: a default/source-query-only revision inherits all 2000–2026, five-source formal scope exactly', () => {
  const baseline = base(), query = '(broiler OR "laying hen" OR swine OR bovine) AND ' + 'ambient_environment OR '.repeat(130) + 'relative_humidity';
  const { result, notice } = parse({ query, sourceQueries: { scopus: query } }, baseline);
  assert.ok(query.length > 2000);
  assert.deepEqual(result, { ...baseline, query, sourceQueries: { ...baseline.sourceQueries, scopus: query } });
  assert.deepEqual(result.sources, baseline.sources, 'Existing selected source order is retained');
  assert.match(notice, /沿用当前草稿/); assert.match(notice, /未自动确认/);
});
test('omitted default query, scope, scientific fields, template and timeouts do not become empty defaults', () => {
  const baseline = base(), { result } = parse({ sourceQueries: { cnki: '养殖环境 温度 湿度' } }, baseline);
  assert.deepEqual(result, { ...baseline, sourceQueries: { ...baseline.sourceQueries, cnki: '养殖环境 温度 湿度' } });
});
test('explicit lists/null/text clears apply only to the fields actually returned', () => {
  const baseline = base(), patch = { inclusion: [], targetFields: [], fieldDefinitions: [], publicationYearFrom: null,
    geography: '', templates: { parameters: null }, sourceQueries: {} };
  const { result } = parse(patch, baseline);
  assert.deepEqual(result, { ...baseline, ...patch, templates: { ...baseline.templates, parameters: null } });
  assert.equal(result.publicationYearTo, 2026); assert.equal(result.searchMode, 'formal'); assert.equal(result.language, baseline.language);
});
test('partial nonempty source-query maps preserve untouched sources and do not use blank text as deletion', () => {
  const baseline = base();
  assert.deepEqual(parse({ sourceQueries: { scopus: 'changed Scopus' } }).result.sourceQueries, { ...baseline.sourceQueries, scopus: 'changed Scopus' });
  for (const sourceQueries of [{ scopus: '' }, { scopus: '   ' }, { scopus: null }, { unknown: 'query' }, [], null]) {
    assert.throws(() => parse({ sourceQueries }), /各来源检索式/);
  }
});
test('explicit invalid/empty sources fail instead of silently inheriting a valid old selection', () => {
  for (const sources of [[], null, 'scopus', [''], ['unknown'], ['scopus', 'scopus'], ['scopus', ' ']]) {
    assert.throws(() => parse({ query: 'changed', sources }), /检索来源/);
  }
});
test('a new configuration without a baseline still requires an explicit valid source list', () => {
  assert.throws(() => parse({ query: 'new query' }, null), /未明确返回检索来源/);
  const { result } = parse({ topic: 'new topic', query: 'new query', sources: ['scopus'] }, null);
  assert.deepEqual(result.sources, ['scopus']); assert.equal(result.searchMode, 'test'); assert.equal(result.stopMode, 'count');
});
test('empty or explanatory-only responses cannot be misreported as a configuration update', () => {
  for (const patch of [{}, { explanation: 'Here is the plan' }, { annotations: [] }, { query: 'changed', reason: 'not a machine field' }]) {
    assert.throws(() => parse(patch), /空配置|不支持的配置字段/);
  }
});
test('only the strict explicit config wrapper is supported, with a visible draft notice', () => {
  const { result, notice } = parse({ config: { query: 'changed query' } });
  assert.equal(result.query, 'changed query'); assert.deepEqual(result.sources, base().sources); assert.match(notice, /明确的 config 对象/);
  for (const patch of [{ config: {}, explanation: 'extra' }, { config: [] }, { config: null }]) assert.throws(() => parse(patch), /包装格式无效/);
  assert.throws(() => parse({ config: {} }), /空配置/);
});
test('existing formal/count budgets are inherited; only an explicit mode change applies mode defaults', () => {
  const baseline = { ...base(), stopMode: 'count', perSourceLimit: 120 };
  assert.deepEqual(parse({ query: 'changed query' }, baseline).result, { ...baseline, query: 'changed query' });
  const { result } = parse({ searchMode: 'test' }, baseline);
  assert.equal(result.searchMode, 'test'); assert.equal(result.stopMode, 'count'); assert.equal(result.perSourceLimit, 10);
  assert.deepEqual(result.sources, baseline.sources); assert.equal(result.publicationYearFrom, 2000);
  for (const searchMode of [null, '', 'execute-all']) assert.throws(() => parse({ searchMode }), /测试运行或正式检索/);
});
test('oversized expressions still fail explicitly and do not truncate the baseline or proposed expression', () => {
  assert.throws(() => parse({ query: 'q'.repeat(32769) }), /32768.*未自动删减/);
  assert.throws(() => parse({ sourceQueries: { scopus: 'q'.repeat(32769) } }), /32768.*未自动删减/);
});
test('preparation prompt requests full machine JSON while declaring safe missing-field/partial-map semantics', () => {
  for (const text of ['完整平铺机器JSON', '原样返回已选sources', '所有省略字段', '包括sources', '按来源逐键更新', '空白检索式或空sources', '用户未确认的新科学范围不补定']) assert.ok(PREPARE_INSTRUCTIONS.includes(text), text);
});
