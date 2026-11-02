'use strict';

// Pure draft preparation plus an inert production-route harness. No model,
// browser, server socket, search, files or research data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildLiteraturePrepare, PREPARE_INSTRUCTIONS, MAX_PREPARE_BYTES, MAX_PREPARE_PART_BYTES } = require('./literature-prepare');

const request = extra => ({ sessionId: 'fixture-session', messages: [{ role: 'user', text: '先整理候选检索规则，不执行。' }], ...extra });

test('long scientific messages, old conversations and approved document tails survive exactly', () => {
  const long = '完整规则。'.repeat(1100) + '最后目标字段：生长；模板路径由用户指定.xlsx';
  const approvedDoc = '已批准规则\n'.repeat(2200) + '最后批准字段不能丢';
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '历史第' + i + '条' }));
  messages.push({ role: 'user', text: long });
  const prepared = buildLiteraturePrepare(request({ messages, approvedDoc }));
  const context = JSON.parse(prepared.messages[0].content);
  assert.deepEqual(context.messages, messages);
  assert.equal(context.messages.at(-1).text, long);
  assert.equal(context.approvedDoc, approvedDoc);
  assert.equal(context.currentConfig, null);
});

test('complete optional schema distinguishes science, record structure and logs without inventing project paths', () => {
  for (const token of ['templates', 'fieldDefinitions', 'key', 'label', 'meaning', 'unit', 'valueType', 'required', 'conditionKeys']) assert.ok(PREPARE_INSTRUCTIONS.includes(token));
  assert.match(PREPARE_INSTRUCTIONS, /执行台账/);
  assert.match(PREPARE_INSTRUCTIONS, /不能把交付模板的12列全部变成12个科学提取指标/);
  assert.match(PREPARE_INSTRUCTIONS, /until仅为discover或dedupe/);
  assert.match(PREPARE_INSTRUCTIONS, /currentConfig是已有未确认草稿参考/);
  assert.match(PREPARE_INSTRUCTIONS, /省略表示保留基线/);
  assert.match(PREPARE_INSTRUCTIONS, /明确清空列表可输出\[\]/);
  assert.match(PREPARE_INSTRUCTIONS, /保持具体字符串/);
  assert.ok(!PREPARE_INSTRUCTIONS.includes('templates/climate'));
  const currentConfig = { topic: '原有草稿', targetFields: ['增重'], fieldDefinitions: [{ key: 'gain', label: '增重', meaning: '原文增重', unit: '原文单位', valueType: 'number', required: false, conditionKeys: ['group'] }],
    templates: { literature: 'templates/user-文献.xlsx', parameters: 'templates/user-参数.xlsx' } };
  const original = JSON.stringify(currentConfig);
  const prepared = buildLiteraturePrepare(request({ currentConfig, until: 'discover' }));
  assert.deepEqual(JSON.parse(prepared.messages[0].content).currentConfig, currentConfig);
  assert.equal(JSON.parse(prepared.messages[0].content).until, 'discover');
  assert.equal(JSON.stringify(currentConfig), original, 'Preparing context cannot mutate the existing draft or confirm it');
});

test('oversized or malformed preparation input is rejected explicitly instead of truncated', () => {
  assert.throws(() => buildLiteraturePrepare(request({ messages: [{ role: 'user', text: 'a'.repeat(MAX_PREPARE_PART_BYTES + 1) }] })), /512KiB.*未截断/);
  assert.throws(() => buildLiteraturePrepare(request({ approvedDoc: 'a'.repeat(MAX_PREPARE_PART_BYTES + 1) })), /512KiB.*未截断/);
  assert.throws(() => buildLiteraturePrepare(request({ messages: Array.from({ length: 5 }, () => ({ role: 'user', text: 'a'.repeat(MAX_PREPARE_PART_BYTES) })) })), /超过2MiB.*未截断/);
  assert.throws(() => buildLiteraturePrepare(request({ messages: Array.from({ length: 201 }, () => ({ role: 'user', text: 'a' })) })), /200条.*未静默裁剪/);
  assert.throws(() => buildLiteraturePrepare(request({ currentConfig: [] })), /对象或null/);
  assert.throws(() => buildLiteraturePrepare(request({ until: 'execute-all' })), /有效阶段/);
  assert.throws(() => buildLiteraturePrepare(request({ approvedDoc: 42 })), /必须是文本/);
  assert.throws(() => buildLiteraturePrepare(request({ messages: [{ role: 'system', text: '不能提升权限' }] })), /角色无效/);
});

test('production prepare route sends full draft context and schema to an inert text-only model; regular chat limits stay unchanged', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const from = source.indexOf('async function handleLiterature('), to = source.indexOf('\nfunction normalizeMessages(', from);
  const calls = [];
  const context = vm.createContext({ JSON, console: { error() {} }, MAX_PREPARE_BYTES, buildLiteraturePrepare,
    codex: { async status() { return { loggedIn: true, model: 'fixture-model' }; },
      async run(...args) { calls.push(args); return { id: 'inert-job', status: 'queued' }; } },
    readBody: async (req, max) => { assert.equal(max, MAX_PREPARE_BYTES); if (Buffer.byteLength(req.body, 'utf8') > max) throw new Error('请求体过大'); return req.body; },
    sendJson(res, status, data) { Object.assign(res, { status, data }); } });
  vm.runInContext(source.slice(from, to), context);
  const long = 'x'.repeat(4500) + '尾部fieldDefinitions与templates必须保留';
  const currentConfig = { targetFields: ['增重'], templates: { parameters: 'templates/user-selected.xlsx' } };
  const raw = request({ messages: [{ role: 'user', text: long }], currentConfig, until: 'discover' });
  const res = {};
  await context.handleLiterature({ method: 'POST', body: JSON.stringify(raw) }, res, new URL('http://fixture/api/literature/prepare'));
  assert.equal(res.status, 202); assert.equal(calls.length, 1);
  const [sessionId, messages, instructions, execute, model, moduleType] = calls[0];
  assert.equal(sessionId, raw.sessionId); assert.equal(execute, false);
  assert.equal(model, 'fixture-model'); assert.equal(moduleType, 'literature-mining');
  const payload = JSON.parse(messages[0].content);
  assert.equal(payload.messages[0].text, long); assert.deepEqual(payload.currentConfig, currentConfig);
  assert.equal(instructions, PREPARE_INSTRUCTIONS);
  const normalizeFrom = source.indexOf('function normalizeMessages('), normalizeTo = source.indexOf('\nfunction errorText(', normalizeFrom);
  const chat = vm.createContext({ MAX_MESSAGES: 30, MAX_MESSAGE_CHARS: 4000 });
  vm.runInContext(source.slice(normalizeFrom, normalizeTo), chat);
  assert.equal(chat.normalizeMessages([{ role: 'user', text: long }])[0].content.length, 4000);
});
