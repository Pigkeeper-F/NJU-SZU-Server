'use strict';

const assert = require('node:assert/strict');
const { normalizeConfig } = require('./literature-config');

const base = { topic: '温度与生产效率', query: 'broiler heat stress', sources: ['google-scholar'], limit: 5,
  batch: { size: 3, maxBatches: 2 } };
const legacy = normalizeConfig(base);
assert.equal(Object.hasOwn(legacy, 'searchMode'), false, '旧任务归一不能追加新模式');
assert.equal(Object.hasOwn(legacy, 'perSourceLimit'), false, '旧任务归一不能追加新目标');
assert.equal(legacy.limit, 5);
assert.deepEqual(legacy.batch, { size: 3, maxBatches: 2 });
assert.deepEqual(normalizeConfig(legacy), legacy, '旧配置往返不改变冻结比较');

const test = normalizeConfig({ ...base, searchMode: 'test', perSourceLimit: 999, limit: 999, batch: { size: 999, maxBatches: 2 } });
assert.equal(test.searchMode, 'test');
assert.equal(test.perSourceLimit, 10);
assert.equal(test.limit, 10);
assert.deepEqual(test.batch, { size: 10, maxBatches: 2 });
assert.deepEqual(normalizeConfig(test), test);
assert.deepEqual(Object.keys(test).slice(0, 13), Object.keys(legacy).slice(0, 13), '前十三个配置字段保持原顺序');
assert.deepEqual(Object.keys(test).slice(13, 15), ['searchMode', 'perSourceLimit']);

const formal = normalizeConfig({ ...base, searchMode: 'formal' });
assert.equal(formal.perSourceLimit, 100);
assert.equal(formal.limit, 10);
assert.deepEqual(formal.batch, { size: 10, maxBatches: 2 });
assert.deepEqual(normalizeConfig(formal), formal);
for (const target of [1, 25, 500, 1000]) {
  assert.equal(normalizeConfig({ ...base, searchMode: 'formal', perSourceLimit: target }).perSourceLimit, target);
}
assert.equal(normalizeConfig({ ...base, searchMode: 'formal', perSourceLimit: '25' }).perSourceLimit, 25, '表单整数可归一');
for (const target of [0, -1, 1001, 1.5, true, false, '', 'all', Infinity]) {
  assert.throws(() => normalizeConfig({ ...base, searchMode: 'formal', perSourceLimit: target }), /每来源检索数量/);
}
for (const mode of ['', 'production', [], true]) {
  assert.throws(() => normalizeConfig({ ...base, searchMode: mode }), /检索模式/);
}
assert.throws(() => normalizeConfig({ ...base, limit: 11 }), /首批检索数量/);
assert.throws(() => normalizeConfig({ ...base, searchMode: 'formal', batch: { maxBatches: 51 } }), /批数上限/);
console.log('LITERATURE_SEARCH_MODES_TESTS_PASS');
