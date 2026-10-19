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
}
assert.equal(resolveLimits({ sources: [] }).discover, 180, '旧配置边界至少一来源预算');
assert.equal(resolveLimits({ sources: Array(20).fill('unknown') }).discover, 1080, '缺省预算最大六来源；来源合法性由配置校验负责');
assert.equal(resolveLimits(null).discover, 180);
assert.equal(resolveLimits({ sources, limits: { discover: -1 } }).discover, 1080, '损坏旧预算回落有效默认值');

const prompt = workflowPrompt({ type: 'literature-mining' }, 'codex');
for (const label of ['Google Scholar', '知网', '万方', 'Web of Science', 'Scopus', 'PubMed']) assert.ok(prompt.includes(label));
assert.ok(prompt.includes('NCBI官方E-utilities接口') && prompt.includes('通常无需登录'));
assert.ok(!prompt.includes('万方、Scopus、PubMed仍未接通'));
console.log('LITERATURE_BUDGET_TESTS_PASS');
