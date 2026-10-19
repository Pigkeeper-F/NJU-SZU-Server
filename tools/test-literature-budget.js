'use strict';

// 多来源串行检索预算：冻结新配置与恢复旧任务必须使用相同默认值，显式预算保持不变。
const assert = require('node:assert/strict');
const { normalizeConfig, DEFAULT_LIMITS } = require('./literature-config');
const { __internals: { resolveLimits } } = require('./literature-connector');
const { workflowPrompt } = require('../server');

const sources = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'];
for (const count of [1, 2, 3, 6]) {
  const raw = { topic: '温度与肉鸡', query: 'broiler heat stress', sources: sources.slice(0, count) };
  const normalized = normalizeConfig(raw, { executable: true });
  assert.equal(normalized.limits.discover, count * 180, '新任务每来源保留 180 秒');
  assert.deepEqual(resolveLimits(raw), normalized.limits, '缺少 limits 的旧配置恢复使用同一预算');
  assert.equal(Object.hasOwn(raw, 'limits'), false, '恢复不能回写冻结配置');
  assert.equal(resolveLimits({ ...raw, limits: { discover: 60, extract: 3600 } }).discover, 60, '显式短预算也须遵守');
  assert.equal(normalizeConfig({ ...raw, limits: { discover: 7200 } }).limits.discover, 7200, '显式较大预算不被六来源上限压缩');
  assert.equal(resolveLimits({ ...raw, limits: { discover: 7200 } }).discover, 7200);
  assert.equal(normalized.limits.dedupe, DEFAULT_LIMITS.dedupe, '其他阶段预算不乘来源数');
  const testMode = normalizeConfig({ ...raw, searchMode: 'test', perSourceLimit: 999 });
  assert.equal(testMode.limits.discover, count * 180, '测试模式固定每源十条，不使用遗留正式数量扩张预算');
  for (const target of [1, 10, 11, 25, 100, 1000]) {
    const formal = { ...raw, searchMode: 'formal', perSourceLimit: target };
    const expected = Math.min(86400, 180 * count * Math.ceil(target / 10));
    const normalizedFormal = normalizeConfig(formal);
    assert.equal(normalizedFormal.limits.discover, expected);
    assert.equal(resolveLimits(formal).discover, expected, '恢复的正式配置与新建配置使用相同分页预算');
    assert.equal(resolveLimits(normalizedFormal).discover, expected);
    assert.equal(normalizeConfig({ ...formal, limits: { discover: 60 } }).limits.discover, 60, '正式模式仍遵守显式短预算');
    assert.equal(resolveLimits({ ...formal, limits: { discover: 7200 } }).discover, 7200);
  }
  assert.equal(resolveLimits({ ...raw, searchMode: 'formal' }).discover, count * 1800, '正式缺省每源100条');
  const end = { ...raw, searchMode: 'formal', stopMode: 'end', perSourceLimit: null };
  assert.equal(normalizeConfig(end).limits.discover, 86400, '到末页使用单次一天运行保护，不使用候选数量乘数');
  assert.equal(resolveLimits(end).discover, 86400);
  assert.equal(resolveLimits({ ...end, perSourceLimit: 1 }).discover, 86400, '遗留数量不能改变到末页预算');
  assert.equal(normalizeConfig({ ...end, limits: { discover: 60 } }).limits.discover, 60);
  assert.equal(resolveLimits({ ...end, limits: { discover: 60 } }).discover, 60);
}
assert.equal(resolveLimits({ sources: [] }).discover, 180, '旧配置边界至少一来源预算');
assert.equal(resolveLimits({ sources: Array(20).fill('unknown') }).discover, 1080, '缺省预算最大六来源；来源合法性由配置校验负责');
assert.equal(resolveLimits(null).discover, 180);
assert.equal(resolveLimits({ sources, limits: { discover: -1 } }).discover, 1080, '损坏旧预算回落有效默认值');

const prompt = workflowPrompt({ type: 'literature-mining' }, 'codex');
for (const label of ['Google Scholar', '知网', '万方', 'Web of Science', 'Scopus', 'PubMed']) assert.ok(prompt.includes(label));
assert.ok(prompt.includes('NCBI官方E-utilities接口') && prompt.includes('通常无需登录'));
assert.ok(!prompt.includes('万方、Scopus、PubMed仍未接通'));
assert.ok(prompt.includes('测试') && prompt.includes('正式') && prompt.includes('自动翻页'));
assert.ok(prompt.includes('stopMode=end') && prompt.includes('perSourceLimit=null') && prompt.includes('可访问末页'));
assert.ok(!prompt.includes('正式模式并设置每来源1–1000条上限'), '新对话不再建议数量上限模式');
console.log('LITERATURE_BUDGET_TESTS_PASS');
