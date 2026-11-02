'use strict';
// Local fixtures only: discussion completion must never create cleaning failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const base = path.resolve(__dirname, '../.workbench/test-fixtures');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'clean-discussion-records-'));
const bridge = new CodexBridge(root);
const acceptance = bridge.cleanAcceptance;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mkdirRun = (session, id = randomUUID()) => {
  const directory = path.join(bridge.session(session), 'output', id);
  fs.mkdirSync(directory);
  return { id, directory };
};
async function main() {
  const session = bridge.createSession().id;
  const empty = mkdirRun(session);
  assert.deepEqual(acceptance.runs(session), []);
  await assert.rejects(acceptance.verify(session, empty.id), /没有可供核验的清洗结果/);
  assert.deepEqual(fs.readdirSync(empty.directory), [], 'An empty discussion remains empty');
  assert.equal(fs.existsSync(acceptance.recordFile(session, empty.id)), false, 'No invented legacy record');

  const absent = randomUUID();
  await assert.rejects(acceptance.verify(session, absent), /没有可供核验的清洗结果/);
  assert.equal(fs.existsSync(path.join(bridge.session(session), 'output', absent)), false);

  // Preserve an older falsely registered empty discussion and its original report.
  const phantom = mkdirRun(session);
  const reportDir = path.join(phantom.directory, 'clean-verification', randomUUID());
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'report.json');
  const oldReport = '{"status":"blocked","checks":[],"files":[]}';
  fs.writeFileSync(reportPath, oldReport);
  acceptance.save({ id: phantom.id, sessionId: session, moduleType: 'clean-data', status: 'legacy', createdAt: new Date().toISOString(), plan: null });
  const recordBytes = fs.readFileSync(acceptance.recordFile(session, phantom.id));
  assert.deepEqual(acceptance.runs(session), []);
  await assert.rejects(acceptance.verify(session, phantom.id), /没有可供核验的清洗结果/);
  assert.equal(fs.readFileSync(reportPath, 'utf8'), oldReport);
  assert.deepEqual(fs.readFileSync(acceptance.recordFile(session, phantom.id)), recordBytes);

  // Future discussion identity survives a backend restart, even if a draft was saved.
  const discussion = mkdirRun(session);
  acceptance.registerDiscussion({ id: discussion.id, sessionId: session });
  fs.writeFileSync(path.join(discussion.directory, 'draft.txt'), 'Only a discussion draft');
  assert.deepEqual(acceptance.runs(session), []);
  const restarted = new CodexBridge(root);
  try {
    assert.deepEqual(restarted.cleanAcceptance.runs(session), []);
    await assert.rejects(restarted.cleanAcceptance.verify(session, discussion.id), /仅为方案讨论/);
    assert.equal(fs.existsSync(path.join(discussion.directory, 'clean-verification')), false);
    assert.equal(json(acceptance.recordFile(session, discussion.id)).kind, 'discussion');
  } finally { restarted.close(); }

  // Existing genuine old data remains listed and blocked until real evidence exists.
  const legacy = mkdirRun(session);
  fs.writeFileSync(path.join(legacy.directory, 'cleaned.csv'), 'id,value\nA,2\n');
  assert.equal(acceptance.runs(session).length, 1);
  assert.equal(acceptance.runs(session)[0].id, legacy.id);
  const legacyReport = await acceptance.verify(session, legacy.id);
  assert.equal(legacyReport.status, 'blocked');
  assert.match(legacyReport.issues[0].evidence[0].detail, /旧结果缺少冻结输入/);
  assert.equal(acceptance.runs(session).length, 1);

  // Exercise actual bridge discussion registration without a model or cleaning run.
  let started;
  const turnStarted = new Promise(resolve => { started = resolve; });
  bridge.status = async () => ({ loggedIn: true, model: 'offline-fixture', models: [{ model: 'offline-fixture' }] });
  bridge.rpc = async method => {
    if (method === 'thread/start') return { thread: { id: 'offline-thread' } };
    if (method === 'turn/start') { started(); return { turn: { id: 'offline-turn' } }; }
    throw Error('Unexpected model request');
  };
  const secondSession = bridge.createSession().id;
  const job = await bridge.run(secondSession, [{ role: 'user', content: '只讨论规则，先不清洗。' }], '', false, null, 'clean-data');
  await turnStarted;
  const live = bridge.jobs.get(job.id);
  assert.equal(live.cleanPlan, undefined);
  bridge.finish(live, 'completed');
  assert.equal(json(acceptance.recordFile(secondSession, job.id)).kind, 'discussion');
  assert.deepEqual(acceptance.runs(secondSession), []);
  await assert.rejects(acceptance.verify(secondSession, job.id), /仅为方案讨论/);
  assert.deepEqual(fs.readdirSync(path.join(bridge.session(secondSession), 'output', job.id)), []);
  console.log('CLEAN_DISCUSSION_RECORDS_PASS: no phantom runs/reports, persisted discussion identity, genuine legacy preserved');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const job of bridge.jobs.values()) clearTimeout(job.timer);
  bridge.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('clean-discussion-records-')) throw Error('Unexpected fixture directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
