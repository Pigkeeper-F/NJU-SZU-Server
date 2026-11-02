'use strict';
// Synthetic fixtures only. No model, production task, download or cleaner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const base = path.resolve(__dirname, '../.workbench/test-fixtures');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'clean-input-binding-'));
const bridge = new CodexBridge(root), acceptance = bridge.cleanAcceptance;
const bytes = Buffer.from('code,value,unit\n004,0,kg\n004,-11,kg\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const inputNames = session => bridge.files(session).filter(file => file.group === 'input').map(file => file.name);
const raw = session => bridge.upload(session, 'synthetic.csv', bytes, 'reference').name;
const bind = (session, names, options = { confirm: true }) => acceptance.bindInput(session, names, options);
const rules = basis => '# Synthetic unchanged original values\n### 清洗核验规则\n本任务无额外专业规则。依据：仅验证输入角色。\n### 原值与结果核对\n仅保留原值，不进行改值。依据：合成用例。\n### 人工核验标准\n'
  + '| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n'
  + '| H1 | 原始记录 | 对照原数据和结果 | 原值一致 | 是 | ' + basis + ' |';

async function run() {
  const session = bridge.createSession().id, name = raw(session);
  const originalPath = bridge.download(session, 'reference', name);
  const history = path.join(bridge.session(session), 'discussion-preserved.txt');
  fs.writeFileSync(history, 'Prior discussion and confirmed rules stay unchanged.');
  await assert.rejects(bind(session, [name], {}), /明确确认/);
  for (const names of [[], [name, name], ['../' + name], ['a/' + name], ['C:\\outside.csv'], [null], ['invalid.exe']]) {
    await assert.rejects(bind(session, names), /明确选择/);
  }
  const other = bridge.createSession().id, otherName = raw(other);
  await assert.rejects(bind(session, [otherName]), /不在当前任务/);
  await assert.rejects(bind(session, [name, 'missing.csv']), /不在当前任务/);
  assert.deepEqual(inputNames(session), [], 'Validate every named source before writing any input');
  const first = await bind(session, [name]);
  assert.deepEqual(first.inputNames, [name]);
  assert.deepEqual(first.boundSources, [name]);
  assert.deepEqual(first.sourceToInput, { [name]: name });
  assert.equal(first.bindings[0].sha256, digest(bytes));
  assert.equal(first.bindings[0].reused, false);
  assert.equal(first.bindings[0].sourceGroup, 'reference');
  assert.deepEqual(fs.readFileSync(originalPath), bytes);
  assert.deepEqual(fs.readFileSync(bridge.download(session, 'input', name)), bytes);
  assert.equal(fs.readFileSync(history, 'utf8'), 'Prior discussion and confirmed rules stay unchanged.');
  const second = await bind(session, [name]);
  assert.equal(second.bindings[0].reused, true);
  assert.deepEqual(inputNames(session), [name], 'Repeated binding reuses the actual same bytes');
  const alias = raw(session);
  const reused = await bind(session, [alias]);
  assert.equal(reused.sourceToInput[alias], name, 'An already available input with identical SHA-256 is reused');
  assert.equal(reused.bindings[0].reused, true);
  const audit = JSON.parse(fs.readFileSync(path.join(bridge.session(session), '.clean-input-bindings.json'), 'utf8'));
  assert.equal(audit.sessionId, session); assert.equal(audit.history.length, 3);
  assert.ok(audit.history.every(item => item.bindings[0].sha256 === digest(bytes)));
  const separateSession = bridge.createSession().id;
  const separate1 = raw(separateSession), separate2 = raw(separateSession);
  const batch = await bind(separateSession, [separate1, separate2]);
  assert.equal(batch.inputNames.length, 1); assert.equal(batch.bindings.length, 2);
  assert.deepEqual(batch.bindings.map(item => item.reused), [false, true]);

  bridge.sourceBusy.add(session);
  await assert.rejects(bind(session, [name]), /正在运行/);
  assert.ok(bridge.sourceBusy.has(session), 'A rejected bind must not clear another operation lock');
  bridge.sourceBusy.delete(session);
  const runningId = randomUUID(); bridge.jobs.set(runningId, { sessionId: session, status: 'running' });
  await assert.rejects(bind(session, [name]), /正在运行/);
  bridge.jobs.delete(runningId);

  const conflictSession = bridge.createSession().id, conflict = raw(conflictSession);
  const conflictFile = path.join(bridge.session(conflictSession), 'input', conflict);
  fs.writeFileSync(conflictFile, 'old version');
  await assert.rejects(bind(conflictSession, [conflict]), /同名不同内容/);
  assert.equal(fs.readFileSync(conflictFile, 'utf8'), 'old version');
  assert.deepEqual(fs.readFileSync(bridge.download(conflictSession, 'reference', conflict)), bytes);
  const emptySession = bridge.createSession().id;
  const emptyName = bridge.upload(emptySession, 'empty.csv', Buffer.alloc(0), 'reference').name;
  await assert.rejects(bind(emptySession, [emptyName]), /非空/);

  const brokenSession = bridge.createSession().id, broken = raw(brokenSession);
  const auditPath = path.join(bridge.session(brokenSession), '.clean-input-bindings.json');
  fs.writeFileSync(auditPath, '{broken history');
  await assert.rejects(bind(brokenSession, [broken]), /未覆盖/);
  assert.equal(fs.readFileSync(auditPath, 'utf8'), '{broken history');
  assert.deepEqual(inputNames(brokenSession), [], 'A failed audit write rolls back newly created inputs');

  const referenceStandard = bridge.upload(session, 'standard.txt', Buffer.from('A synthetic independent scope standard.'), 'reference').name;
  const planText = rules(name + ' input record 2；' + referenceStandard + ' section 1');
  const plan = await acceptance.freeze(session, { text: planText, version: 1, inputNames: [name], standardNames: [referenceStandard] });
  assert.equal(plan.inputFiles[0].sha256, digest(bytes));
  assert.equal(plan.standardFiles.length, 1); assert.equal(plan.standardFiles[0].name, referenceStandard);
  await assert.rejects(acceptance.freeze(session, { text: planText, version: 1, inputNames: [name], standardNames: [name] }), /同时作为清洗数据/);
  await assert.rejects(acceptance.freeze(session, { text: rules(alias), version: 1, inputNames: [name], standardNames: [alias] }), /同时绑定为清洗输入和人工标准/);
  assert.deepEqual(fs.readFileSync(originalPath), bytes, 'The original attachment remains unchanged after binding and plan freeze');
  assert.equal(bridge.sourceBusy.size, 0);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /route === '\/api\/codex\/clean\/bind-input'/);
  assert.match(server, /data\.sourceSessionId && data\.sourceSessionId !== data\.sessionId/);
  assert.match(server, /cleanAcceptance\.bindInput\(data\.sessionId, data\.names, \{ confirm: data\.confirm \}\)/);
  console.log('CLEAN_INPUT_BINDING_PASS (explicit local sources, SHA-256 reuse, read-only originals/history, busy/path/version guards, independent standard role, endpoint wiring)');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  bridge.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('clean-input-binding-')) throw Error('Unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
