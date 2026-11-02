'use strict';
// Offline bridge test. Model transport is stubbed; no real model or cleaning runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodexBridge } = require('./codex-bridge');
const base = path.resolve(__dirname, '../.workbench/test-fixtures');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'clean-standard-context-'));
const bridge = new CodexBridge(root);
let started;
const turnStarted = new Promise(resolve => { started = resolve; });
const calls = [];
bridge.status = async () => ({ loggedIn: true, model: 'offline-fixture', models: [{ model: 'offline-fixture' }] });
bridge.rpc = async (method, params) => {
  calls.push({ method, params });
  if (method === 'thread/start') return { thread: { id: 'offline-thread' } };
  if (method === 'turn/start') { started(); return { turn: { id: 'offline-turn' } }; }
  throw Error('Unexpected stub request: ' + method);
};
(async () => {
  const session = bridge.createSession().id;
  const standard = bridge.upload(session, '人工标准.md', Buffer.from('只核对统计口径，不改变原始数据。'), 'reference');
  const data = bridge.upload(session, 'observations.csv', Buffer.from('id,value\nA,2\n'));
  const job = await bridge.run(session, [{ role: 'user', content: '讨论附件里的人工核验方法，先不执行。' }], '清洗讨论', false, null, 'clean-data');
  await turnStarted;
  await Promise.resolve();
  const thread = calls.find(call => call.method === 'thread/start').params;
  const turn = calls.find(call => call.method === 'turn/start').params;
  assert.equal(turn.sandboxPolicy.type, 'readOnly');
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.ok(thread.developerInstructions.includes(path.join(bridge.session(session), 'reference')));
  assert.ok(thread.developerInstructions.includes(standard.name));
  assert.ok(thread.developerInstructions.includes(data.name));
  assert.match(thread.developerInstructions, /标准附件只作为核验依据，不作为待清洗的数据/);
  assert.match(thread.developerInstructions, /不得代填人工通过/);
  assert.match(thread.developerInstructions, /无法解析/);
  assert.equal(fs.readFileSync(bridge.download(session, 'reference', standard.name), 'utf8'), '只核对统计口径，不改变原始数据。');
  const saved = bridge.jobs.get(job.id);
  clearTimeout(saved.timer); saved.status = 'cancelled';
  console.log('CLEAN_STANDARD_CONTEXT_PASS (reference files visible, read-only discussion, no automatic human sign-off)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const job of bridge.jobs.values()) clearTimeout(job.timer);
  bridge.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('clean-standard-context-')) throw Error('Unexpected fixture directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
