#!/usr/bin/env node
/* 模型设置（模型分组 v2）逻辑测试 —— node tools/test-llm-settings.js
 * 用 vm + localStorage stub 加载 js/store.js，验证 Store.llmSettings 的
 * 迁移 / 规范化 / 分组增删改查 / 模型自动并入 / 脏数据容错 / clear 语义。 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const data = new Map();
const browser = {
  console,
  localStorage: {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), { window: browser });
const llm = browser.Store.llmSettings;
assert.ok(llm, 'Store.llmSettings 必须导出');

// vm 沙箱对象与主 realm 原型不同，深度比较前统一成纯 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));

// 1. 空白存储：空结构 + resolve=null
assert.deepEqual(plain(llm.read()), { version: 2, activeGroupId: '', groups: [] });
assert.equal(llm.resolve(llm.read()), null);

// 2. v1 迁移：单配置 → 默认分组（模型自动入列表）
data.set('fa_llm_settings_v1', JSON.stringify({
  baseUrl: 'https://a.example/v1', apiKey: 'sk-a', model: 'm1', protocol: 'responses', systemPrompt: 'sp'
}));
const norm = llm.read();
assert.equal(norm.version, 2);
assert.equal(norm.groups.length, 1);
assert.equal(norm.groups[0].name, '默认分组');
assert.equal(norm.groups[0].baseUrl, 'https://a.example/v1');
assert.deepEqual(plain(norm.groups[0].models), ['m1']);
assert.equal(norm.activeGroupId, norm.groups[0].id);
assert.deepEqual(plain(llm.resolve(norm)), {
  baseUrl: 'https://a.example/v1', model: 'm1', apiKey: 'sk-a', protocol: 'responses', systemPrompt: 'sp'
});

// 3. 新建分组 + 保存字段（当前模型自动并入列表）；写回后读回一致
const firstId = norm.groups[0].id;
llm.addGroup(norm, '');
assert.equal(norm.groups.length, 2);
const secondId = norm.activeGroupId;
assert.notEqual(secondId, firstId);
llm.updateGroup(norm, secondId, {
  baseUrl: 'https://b.example/v1', apiKey: 'sk-b', model: 'm2a', protocol: 'chat-completions', systemPrompt: ''
});
assert.equal(llm.write(norm), true);
const norm2 = llm.read();
assert.equal(norm2.groups.length, 2);
assert.equal(norm2.activeGroupId, secondId);
assert.deepEqual(plain(llm.resolve(norm2)), {
  baseUrl: 'https://b.example/v1', model: 'm2a', apiKey: 'sk-b', protocol: 'chat-completions'
});

// 4. 同分组再保存另一模型：列表增长、当前模型切换
llm.updateGroup(norm2, secondId, {
  baseUrl: 'https://b.example/v1', apiKey: 'sk-b', model: 'm2b', protocol: 'chat-completions', systemPrompt: ''
});
assert.equal(llm.write(norm2), true);
const groupB = llm.activeGroup(llm.read());
assert.deepEqual(plain(groupB.models), ['m2a', 'm2b']);
assert.equal(groupB.model, 'm2b');

// 5. 删分组：激活项回退到相邻；最后一个不允许删
assert.equal(llm.removeGroup(norm2, secondId), true);
assert.equal(llm.write(norm2), true);
const norm3 = llm.read();
assert.equal(norm3.groups.length, 1);
assert.equal(norm3.activeGroupId, firstId);
assert.equal(llm.removeGroup(norm3, firstId), false);

// 6. clear：resolve 回到 null
assert.equal(llm.clear(), true);
assert.equal(llm.resolve(llm.read()), null);

// 7. 脏数据容错：坏 JSON / models 重复与空白
data.set('fa_llm_settings_v1', '{broken json');
assert.equal(llm.resolve(llm.read()), null);
data.set('fa_llm_settings_v1', JSON.stringify({
  groups: [{ baseUrl: 'https://c.example/v1', model: 'm', models: ['m', 'm', '  '] }]
}));
const norm4 = llm.read();
assert.equal(norm4.groups.length, 1);
assert.deepEqual(plain(norm4.groups[0].models), ['m']);

console.log('LLM_SETTINGS_TESTS_PASS');
