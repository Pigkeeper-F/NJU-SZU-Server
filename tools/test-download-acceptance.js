'use strict';
// Synthetic local files only: no network, model, actual source job or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const { SourceDownloads } = require('./faostat-download');
const { writeJson } = require('./source-transfer');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const project = path.resolve(__dirname, '..'), base = path.join(project, '.workbench', 'test-fixtures');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'download-acceptance-test-'));
const bridge = new CodexBridge(root), downloads = new SourceDownloads(root, bridge), verifier = downloads.verification;
const session = bridge.createSession().id;
const header = 'Reporter Country Code,Partner Country Code,Item Code,Element Code,Year,Unit,Value,Flag\n';
let sequence = 0;
function makeJob(rows, options = {}) {
  const id = randomUUID(), sid = options.session || session;
  const name = options.name || 'FAOSTAT_TM_2024.csv';
  const data = Buffer.from((options.generic ? 'Year,Country,Value\n' : header) + rows);
  const input = path.join(bridge.session(sid), 'input', id); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, name), data);
  const job = { sourceJob: true, id, sessionId: sid, kind: options.generic ? 'files' : 'faostat-tm',
    rules: options.rules || (options.generic ? '公开CSV 2024，保留原值 https://fixture.invalid/data.csv' : 'FAOSTAT TM 2024年全部记录，保留原值与单位') + '\n\n### 专业核验规则\n本任务无额外专业规则。依据：此离线用例专门检查文件和版本交接。',
    config: options.generic ? undefined : { dataset: 'TM', years: options.years || [2024], filters: options.filters || {} },
    result: options.generic ? undefined : { zipCRCVerified: true },
    sources: options.generic ? [{ url: 'https://fixture.invalid/data.csv', name }] : [],
    catalog: options.generic ? undefined : { DatasetCode: 'TM', DateUpdate: 'fixture-' + sequence },
    deliverables: [{ name, storedName: id + '/' + name, size: data.length, sha256: sha(data), finalUrl: 'https://fixture.invalid/data.csv' }],
    createdAt: '2026-10-01T00:00:' + String(++sequence).padStart(2, '0') + '.000Z', status: 'completed', stage: 'completed', message: 'synthetic file fixture' };
  fs.mkdirSync(downloads.location(sid, id)); fs.writeFileSync(path.join(downloads.location(sid, id), 'approved-plan.md'), job.rules); downloads.save(job); return job;
}
async function acceptWarnings(job, report) {
  for (const issue of report.issues.filter(issue => issue.canAccept && !issue.resolution)) report = verifier.decide(job.sessionId, job.id, report.id, issue.id, 'accept', '已核对本测试证据，接受该明确变化并保留旧版本。');
  return report;
}
async function run() {
  const first = makeJob('1,2,15,5610,2024,t,10,A\n3,4,15,5610,2024,t,20,A\n');
  const original = fs.readFileSync(bridge.download(session, 'input', first.deliverables[0].storedName));
  const initial = await verifier.verify(session, first.id);
  assert.equal(initial.status, 'ready', JSON.stringify(initial.issues));
  assert.equal(initial.baseline.mode, 'first'); assert.equal(initial.summary.currentRows, 2);
  const target = bridge.createSession().id;
  const firstImport = await verifier.importInput(target, session, first.deliverables.map(file => file.storedName), 'input', () => bridge.importInput(target, session, first.deliverables.map(file => file.storedName)));
  assert.ok(firstImport.names.length); assert.ok(downloads.load(session, first.id).acceptanceConfirmed);
  assert.deepEqual(fs.readFileSync(bridge.download(session, 'input', first.deliverables[0].storedName)), original);

  const updated = makeJob('1,2,15,5610,2024,kg,12,A\n5,6,15,5610,2024,t,30,A\n');
  let report = await verifier.verify(session, updated.id);
  assert.equal(report.status, 'needs_decision', JSON.stringify(report.issues));
  assert.equal(report.baseline.jobId, first.id); assert.equal(report.summary.revised, 1); assert.equal(report.summary.removed, 1); assert.equal(report.summary.added, 1); assert.equal(report.summary.unitChanges, 1);
  assert.ok(report.artifacts.some(file => /differences/.test(file.name)));
  await assert.rejects(verifier.importInput(target, session, updated.deliverables.map(file => file.storedName), 'input', () => { throw Error('must not copy'); }), /待决定/);
  const decisionIssue = report.issues.find(issue => issue.canAccept);
  assert.throws(() => verifier.decide(session, updated.id, 'stale', decisionIssue.id, 'accept', '理由'), /已变化/);
  assert.throws(() => verifier.decide(session, updated.id, report.id, decisionIssue.id, 'accept', ''), /简短依据/);
  report = await acceptWarnings(updated, report); assert.equal(report.status, 'ready');
  const oldId = report.id, rerun = await verifier.verify(session, updated.id);
  assert.notEqual(rerun.id, oldId); assert.equal(rerun.status, 'ready', 'Rechecking identical content must retain evidence-bound decisions');
  assert.ok(rerun.issues.every(issue => issue.resolution?.decision === 'accept'));
  assert.throws(() => verifier.decide(session, updated.id, oldId, decisionIssue.id, 'accept', '旧报告'), /已变化/);

  for (const alias of ['./' + updated.deliverables[0].storedName, updated.deliverables[0].storedName.replace('/', '\\'), 'x/../' + updated.deliverables[0].storedName]) {
    await assert.rejects(verifier.importInput(target, session, [alias], 'input', () => { throw Error('bypass'); }), /规范文件名/);
  }
  if (process.platform === 'win32') await assert.rejects(verifier.importInput(target, session, [updated.id.toUpperCase() + '/' + path.basename(updated.deliverables[0].storedName)], 'input', () => { throw Error('uppercase bypass'); }), /规范文件名/);
  await assert.rejects(verifier.importInput(target, session, [updated.id + '/approved-plan.md'], 'output', () => { throw Error('raw bypass'); }), /只允许/);
  await assert.rejects(verifier.importInput(target, session, updated.deliverables.map(file => file.storedName), 'input', () => { throw Error('stale bypass'); }, { verificationReportId: oldId }), /过期/);
  const updatedPath = bridge.download(session, 'input', updated.deliverables[0].storedName);
  fs.writeFileSync(updatedPath, fs.readFileSync(updatedPath, 'utf8').replace(',12,A', ',99,A'));
  await assert.rejects(verifier.importInput(target, session, updated.deliverables.map(file => file.storedName), 'input', () => { throw Error('tampered bypass'); }), /发生变化/);
  const tampered = await verifier.verify(session, updated.id); assert.equal(tampered.status, 'blocked');
  const error = tampered.issues.find(issue => issue.severity === 'error'); assert.ok(error); assert.throws(() => verifier.decide(session, updated.id, tampered.id, error.id, 'accept', '强行通过'), /不能直接接受/);
  const nextYear = makeJob('1,2,15,5610,2025,t,15,A\n', { years: [2025] });
  const windowReport = await verifier.verify(session, nextYear.id);
  assert.equal(windowReport.status, 'ready', 'An explicitly requested new year is not an unexplained deletion');
  assert.equal(windowReport.summary.added, 1); assert.equal(windowReport.summary.removed, 0);
  assert.ok(windowReport.checks.some(check => check.id === 'year_window'));

  const cancelledJob = makeJob('1,2,15,5610,2024,t,10,A\n');
  const originalEngine = verifier.engine; let finishEngine, beganEngine;
  const began = new Promise(resolve => { beganEngine = resolve; });
  verifier.engine = () => { beganEngine(); return new Promise(resolve => { finishEngine = resolve; }); };
  const pendingVerification = verifier.verify(session, cancelledJob.id); await began;
  verifier.cancel(cancelledJob.id); finishEngine({});
  const cancelledReport = await pendingVerification; verifier.engine = originalEngine;
  assert.equal(cancelledReport.status, 'blocked'); assert.match(cancelledReport.issues[0].evidence[0].detail, /已停止/);

  const genericSession = bridge.createSession().id, generic = makeJob('2024,China,9\n', { generic: true, session: genericSession, name: 'data.csv' });
  let genericReport = await verifier.verify(genericSession, generic.id);
  assert.ok(genericReport.issues.some(issue => issue.code === 'scope_semantics')); genericReport = await acceptWarnings(generic, genericReport);
  assert.equal(genericReport.status, 'ready'); const genericRepeat = await verifier.verify(genericSession, generic.id); assert.equal(genericRepeat.status, 'ready');

  const legacySession = bridge.createSession().id, legacyBytes = Buffer.from('Year,Value\n2024,7\n'), legacyRules = '取得本地测试原文件，保留原始字段';
  const saved = bridge.saveSource(legacySession, { name: 'legacy.csv', data: legacyBytes }, { ok: true, name: 'legacy.csv', rules: legacyRules, size: legacyBytes.length, sha256: sha(legacyBytes), finalUrl: 'https://fixture.invalid/legacy.csv' });
  await assert.rejects(verifier.importInput(target, legacySession, [saved.download.storedName], 'input', () => { throw Error('legacy bypass'); }), /旧下载文件/);
  const adopted = verifier.adopt(legacySession, legacyRules, [saved.download.storedName]);
  assert.equal(verifier.adopt(legacySession, legacyRules, [saved.download.storedName]), adopted, 'Recovery must not recreate the source batch');
  const legacyReport = await verifier.verify(legacySession, adopted); assert.equal(legacyReport.jobId, adopted);
  assert.deepEqual(fs.readFileSync(bridge.download(legacySession, 'input', saved.download.storedName)), legacyBytes);
  assert.throws(() => verifier.adopt(legacySession, legacyRules + '变更', [saved.download.storedName]), /真实下载记录/);
  const upload = bridge.upload(legacySession, 'ordinary.csv', legacyBytes);
  const ordinary = await verifier.importInput(target, legacySession, [upload.name], 'input', () => bridge.importInput(target, legacySession, [upload.name])); assert.equal(ordinary.names.length, 1);
  const professionalPlan = 'FAOSTAT TM 2024年全部记录，保留原值与单位\n\n### 专业核验规则\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| P01 | Unit | 允许值 | t | Element Code=5610 | 本合成数据的单位约定 |\n| P02 | Value | 数值范围 | 最小=0 | 全部 | 本合成数据须非负 |';
  const professionalSession = bridge.createSession().id;
  const professional = makeJob('1,2,15,5610,2024,t,-10,A\n', { session: professionalSession, rules: professionalPlan });
  const professionalBytes = fs.readFileSync(bridge.download(professionalSession, 'input', professional.deliverables[0].storedName));
  let professionalReport = await verifier.verify(professionalSession, professional.id);
  assert.equal(professionalReport.status, 'needs_decision', JSON.stringify(professionalReport.issues));
  assert.equal(professionalReport.summary.professionalPassed, 1); assert.equal(professionalReport.summary.professionalPending, 1);
  const ruleIssue = professionalReport.issues.find(issue => issue.ruleId === 'P02'); assert.ok(ruleIssue);
  assert.ok(ruleIssue.evidence.some(value => value.label === '原文件定位示例' && value.detail.includes('-10')));
  assert.ok(ruleIssue.evidence.some(value => value.artifact?.name.endsWith('.jsonl')));
  professionalReport = await acceptWarnings(professional, professionalReport); assert.equal(professionalReport.status, 'ready');
  assert.equal(professionalReport.summary.professionalPending, 0); assert.equal(professionalReport.summary.professionalExceptions, 1);
  assert.equal(professionalReport.professionalChecks.find(check => check.id === 'P02').status, 'needs_decision', 'Accepting an exception is not an automatic pass');
  assert.equal((await verifier.verify(professionalSession, professional.id)).status, 'ready', 'Same rule evidence retains the decision');
  assert.deepEqual(fs.readFileSync(bridge.download(professionalSession, 'input', professional.deliverables[0].storedName)), professionalBytes);
  const staleEngine = verifier.get(professionalSession, professional.id); staleEngine.engineVersion = 'older-engine'; verifier.save(downloads.load(professionalSession, professional.id), staleEngine);
  await assert.rejects(verifier.importInput(target, professionalSession, professional.deliverables.map(file => file.storedName), 'input', () => { throw Error('outdated rule engine bypass'); }), /引擎已更新/);
  const unstated = makeJob('1,2,15,5610,2024,t,10,A\n', { session: bridge.createSession().id, rules: '仅有通用文件检查，未列专业规则' });
  const unstatedReport = await verifier.verify(unstated.sessionId, unstated.id);
  assert.equal(unstatedReport.status, 'needs_decision'); assert.ok(unstatedReport.issues.some(issue => issue.ruleId === 'professional-unspecified'));
  bridge.sourceBusy.add(session); await assert.rejects(async () => verifier.verify(session, first.id), /正在运行/); bridge.sourceBusy.delete(session);
  assert.equal(bridge.sourceBusy.size, 0); assert.equal(verifier.pending.size, 0);
  console.log('DOWNLOAD_ACCEPTANCE_TESTS_PASS (local profiles, historical changes, evidence-bound decisions, stale/tampered/path gates, legacy recovery, unchanged originals)');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  downloads.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(base) || !path.basename(root).startsWith('download-acceptance-test-')) throw Error('Unexpected fixture path');
  fs.rmSync(root, { recursive: true, force: true });
});
