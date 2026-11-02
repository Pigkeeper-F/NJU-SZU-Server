'use strict';
// Precomputed synthetic files only. No cleaner, model, download or real task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CodexBridge } = require('./codex-bridge');
const { writeJson } = require('./source-transfer');
const base = path.resolve(__dirname, '../.workbench/test-fixtures'); fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'clean-acceptance-'));
const bridge = new CodexBridge(root), acceptance = bridge.cleanAcceptance;
const none = '# 合成清洗规则\n\n### 清洗核验规则\n本任务无额外专业规则。依据：此测试专门核对原值与去向。\n\n### 原值与结果核对\n仅保留原值，不进行改值。依据：此测试要求全部原值保留。';
const table = '| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n';
const manualTable = '\n\n### 人工核验标准\n| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n';
const manualText = basis => none + manualTable
  + '| H01 | 统计口径一致 | 对照原始数据字典逐项核对 | 范围和定义完全一致 | 是 | ' + basis + ' |\n'
  + '| H02 | 可选展示格式 | 阅读结果表头 | 术语清晰 | 否 | 合成测试的可选展示规则 |';
const manualSign = (item, reportId, checkId, conclusion, note, evidence, reviewer, options = { rulesText: item.text, standardNames: item.standardNames }) => acceptance.manualCheck(item.session, item.id, reportId, checkId, conclusion, note, evidence, reviewer, options);
async function fixture(options = {}) {
  const session = bridge.createSession().id;
  const original = Buffer.from(options.input || 'id,value,unit\nA,2,kg\n');
  const inputName = bridge.upload(session, 'input.csv', original).name;
  const standardNames = (options.standards || []).map(item => bridge.upload(session, item.name, Buffer.from(item.content || 'Synthetic reference standard only'), 'reference').name);
  const text = typeof options.text === 'function' ? options.text(standardNames) : options.text || none;
  const plan = await acceptance.freeze(session, { text, version: 1, inputNames: [inputName], standardNames });
  const id = randomUUID(), directory = path.join(bridge.session(session), 'output', id); fs.mkdirSync(directory);
  const job = { id, sessionId: session, status: 'running', createdAt: new Date().toISOString(), cleanPlan: plan };
  acceptance.register(job);
  fs.writeFileSync(path.join(directory, 'cleaned.csv'), options.output || original);
  writeJson(path.join(directory, 'cleaning-manifest.json'), { schema: 1, planSha256: plan.sha256, outputs: [{ name: 'cleaned.csv', role: 'cleaned' }], lineage: 'row-lineage.jsonl' });
  const relations = [{ sources: [{ file: inputName, record: 1 }], targets: [{ file: 'cleaned.csv', record: 1 }], action: 'keep', ruleIds: [] }];
  if (options.duplicate) relations.push({ sources: [{ file: inputName, record: 2 }], targets: [], action: 'duplicate', ruleIds: ['D01'], retainedSource: { file: inputName, record: 1 } });
  fs.writeFileSync(path.join(directory, 'row-lineage.jsonl'), relations.map(value => JSON.stringify(value)).join('\n') + '\n');
  const record = acceptance.load(session, id); record.status = 'completed'; acceptance.save(record);
  return { session, id, directory, inputName, standardNames, text, original, job };
}
async function run() {
  const missingPlanSession = bridge.createSession().id;
  await assert.rejects(bridge.run(missingPlanSession, [{role:'user',content:'合成清洗'}], '', true, null, 'clean-data'), /确认清洗方案/);
  assert.equal(bridge.jobs.size, 0, 'A missing frozen plan must fail before model execution');
  const first = await fixture();
  assert.equal(acceptance.runs(first.session)[0].planText, first.text);
  const firstReport = await acceptance.verify(first.session, first.id);
  assert.equal(firstReport.status, 'ready', JSON.stringify(firstReport.issues));
  assert.equal(firstReport.summary.inputRows, 1); assert.equal(firstReport.summary.cleanedRows, 1);
  const target = bridge.createSession().id, names = firstReport.cleanedNames;
  await assert.rejects(acceptance.importInput(target, first.session, names, 'output', () => { throw Error('not confirmed'); }), /尚未最终确认/);
  await assert.rejects(acceptance.confirm(first.session, first.id, firstReport.id, first.text + '变更'), /版本已变化/);
  const confirmed = await acceptance.confirm(first.session, first.id, firstReport.id, first.text); assert.equal(confirmed.confirmed, true);
  const imported = await acceptance.importInput(target, first.session, names, 'output', () => bridge.importInput(target, first.session, names, 'output'), { cleanRunId: first.id, cleanReportId: firstReport.id });
  assert.equal(imported.names.length, 1); assert.deepEqual(fs.readFileSync(bridge.download(first.session, 'input', first.inputName)), first.original);
  await assert.rejects(acceptance.importInput(target, first.session, [first.id + '/approved-clean-plan.json'], 'output', () => { throw Error('metadata bypass'); }), /主结果清单/);
  if (process.platform === 'win32') await assert.rejects(acceptance.importInput(target, first.session, [first.id.toUpperCase() + '/cleaned.csv'], 'output', () => { throw Error('alias bypass'); }), /路径别名/);
  fs.appendFileSync(path.join(first.directory, 'cleaned.csv'), 'B,3,kg\n');
  await assert.rejects(acceptance.confirm(first.session, first.id, firstReport.id, first.text), /文件或逐条依据发生变化/);
  const broken = await acceptance.verify(first.session, first.id); assert.equal(broken.status, 'blocked');
  const blocked = broken.issues.find(item => item.severity === 'error'); assert.throws(() => acceptance.decide(first.session, first.id, broken.id, blocked.id, 'accept', '强制通过'), /不能强行接受/);

  const transformPlan = '# 合成单位规则\n### 清洗核验规则\n本任务无额外专业规则。依据：此测试专门核对换算与去向。\n### 原值与结果核对\n' + table
    + '| V01 | value | 数值换算 | 乘=1000 | unit=kg | 本合成测试固定单位换算 |\n| V02 | unit | 名称映射 | kg→g | 全部 | 本合成测试固定单位映射 |';
  const converted = await fixture({ text: transformPlan, output: 'id,value,unit\nA,2000,g\n' });
  const convertedReport = await acceptance.verify(converted.session, converted.id); assert.equal(convertedReport.status, 'ready', JSON.stringify(convertedReport.issues));
  const wrong = await fixture({ text: transformPlan, output: 'id,value,unit\nA,2001,g\n' });
  const wrongReport = await acceptance.verify(wrong.session, wrong.id); assert.equal(wrongReport.status, 'blocked'); assert.ok(wrongReport.issues.some(item => item.code === 'value-result-wrong'));
  const duplicateData = { input: 'id,value,unit\nA,2,kg\nA,2,kg\n', output: 'id,value,unit\nA,2,kg\n', duplicate: true };
  const unapprovedDuplicate = await fixture(duplicateData);
  assert.equal((await acceptance.verify(unapprovedDuplicate.session, unapprovedDuplicate.id)).status, 'needs_decision', 'Identical observations cannot be deleted without a confirmed duplicate policy');
  const duplicatePlan = '# 合成去重方案\n### 清洗核验规则\n本任务无额外专业规则。依据：此测试核对去重及来源。\n### 原值与结果核对\n' + table + '| D01 | 全部原字段 | 完全重复去重 | 保留最早原始记录 | 全部 | 本合成测试明确允许全行相同去重 |';
  const approvedDuplicate = await fixture({ ...duplicateData, text: duplicatePlan });
  const duplicateReport = await acceptance.verify(approvedDuplicate.session, approvedDuplicate.id);
  assert.equal(duplicateReport.status, 'ready', JSON.stringify(duplicateReport.issues)); assert.equal(duplicateReport.summary.duplicateRows, 1);

  const unexplained = await fixture({ output: 'id,value,unit\nA,3,kg\n' });
  let report = await acceptance.verify(unexplained.session, unexplained.id); assert.equal(report.status, 'needs_decision');
  const issue = report.issues.find(item => item.canAccept); assert.ok(issue.evidence.some(value => value.artifact));
  assert.throws(() => acceptance.decide(unexplained.session, unexplained.id, 'stale', issue.id, 'accept', '依据'), /已变化/);
  assert.throws(() => acceptance.decide(unexplained.session, unexplained.id, report.id, issue.id, 'accept', ''), /简短依据/);
  report = acceptance.decide(unexplained.session, unexplained.id, report.id, issue.id, 'accept', '已核对此合成用例，接受本批明确例外并保留未自动核验状态。');
  assert.equal(report.status, 'ready'); const again = await acceptance.verify(unexplained.session, unexplained.id); assert.equal(again.status, 'ready', 'Identical evidence should retain decisions');
  assert.equal(again.summary.acceptedExceptions, 1);

  // Standards are independent reference originals. Listing an attachment is
  // not adoption, not a data input, and never evidence of a human pass.
  const standardSession = bridge.createSession().id;
  const standardInput = bridge.upload(standardSession, 'data.csv', Buffer.from('id,value\nA,2\n')).name;
  const standardName = bridge.upload(standardSession, 'human-standard.pdf', Buffer.from('%PDF-synthetic-unparsed-standard'), 'reference').name;
  await assert.rejects(acceptance.freeze(standardSession, { text: none + '\n标准：' + standardName, version: 1, inputNames: [standardInput], standardNames: [standardName] }), /尚未落实/);
  await assert.rejects(acceptance.freeze(standardSession, { text: '# 附件清单\n' + standardName + '\n\n' + manualText('与附件无关的合成规则'), version: 1, inputNames: [standardInput], standardNames: [standardName] }), /尚未落实/);
  await assert.rejects(acceptance.freeze(standardSession, { text: none + manualTable + '| H01 | 待确认 | 待讨论 | 待确认 | 是 | 暂定 |', version: 1, inputNames: [standardInput] }), /尚未明确/);
  await assert.rejects(acceptance.freeze(standardSession, { text: manualText(standardInput), version: 1, inputNames: [standardInput], standardNames: [standardInput] }), /不能同时作为清洗数据/);
  await assert.rejects(acceptance.freeze(standardSession, { text: manualText('missing-reference.txt'), version: 1, inputNames: [standardInput], standardNames: ['missing-reference.txt'] }), /不在当前任务/);
  const standardPlan = await acceptance.freeze(standardSession, { text: manualText(standardName + ' 第1节'), version: 1, inputNames: [standardInput], standardNames: [standardName] });
  assert.equal(standardPlan.inputFiles.length, 1); assert.equal(standardPlan.standardFiles[0].group, 'reference'); assert.equal(standardPlan.standardFiles[0].name, standardName);
  assert.match(acceptance.guidance(standardPlan), /不得代填人工结论/);

  const human = await fixture({ standards: [{ name: '口径标准.md' }], text: names => manualText(names[0] + ' 第2节') });
  let humanReport = await acceptance.verify(human.session, human.id);
  const autoChecks = JSON.stringify(humanReport.checks);
  assert.equal(humanReport.status, 'needs_manual'); assert.equal(humanReport.manualChecks.length, 2);
  assert.equal(humanReport.summary.manualRequired, 1); assert.equal(humanReport.summary.manualRequiredPending, 1);
  assert.ok(humanReport.files.some(file => file.group === 'reference' && file.role === 'standard'));
  assert.deepEqual(acceptance.runs(human.session)[0].standardFiles, human.job.cleanPlan.standardFiles);
  await assert.rejects(acceptance.confirm(human.session, human.id, humanReport.id, human.text), /必需人工核验未通过/);
  assert.throws(() => acceptance.decide(human.session, human.id, humanReport.id, 'H01', 'accept', '绕过人工标准'), /不能强行接受/);
  await assert.rejects(acceptance.manualCheck(human.session, human.id, humanReport.id, 'H01', 'passed', '未提供当前方案不能签', '标准第2节', '合成研究者'), /当前显示的已确认清洗方案/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '未提供当前附件清单不能签', '标准第2节', '合成研究者', { rulesText: human.text }), /完整标准原件清单/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '旧方案不能签当前结果', '标准第2节', '合成研究者', { rulesText: human.text + '\n修订内容', standardNames: human.standardNames }), /版本已变化/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '漏了标准附件不能签', '标准第2节', '合成研究者', { rulesText: human.text, standardNames: [] }), /清单已变化/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '新增标准未重新核验不能签', '标准第2节', '合成研究者', { rulesText: human.text, standardNames: [...human.standardNames, 'new-standard.md'] }), /清单已变化/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '已核对', '', '合成研究者'), /依据的位置/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '', '标准第2节/原始第1行', '合成研究者'), /简短说明/);
  await assert.rejects(manualSign(human, humanReport.id, 'H01', 'passed', '已核对', '标准第2节/原始第1行', ''), /核验人/);
  await assert.rejects(manualSign(human, randomUUID(), 'H01', 'passed', '已核对', '标准第2节/原始第1行', '合成研究者'), /版本已变化/);
  humanReport = await manualSign(human, humanReport.id, 'H01', 'passed', '范围和定义一致', '标准第2节；input第1行与cleaned.csv第1行', '合成研究者');
  assert.equal(humanReport.status, 'ready', 'Optional pending manual item must remain visible without blocking');
  assert.equal(humanReport.manualChecks[1].resolution, null); assert.equal(humanReport.summary.manualPending, 1);
  assert.equal(humanReport.manualChecks[0].resolution.actor, 'researcher'); assert.equal(humanReport.manualChecks[0].history.length, 1);
  assert.equal(JSON.stringify(humanReport.checks), autoChecks, 'Human signatures must not rewrite independent automatic checks');
  await acceptance.confirm(human.session, human.id, humanReport.id, human.text);
  const humanTarget = bridge.createSession().id;
  const humanImported = await acceptance.importInput(humanTarget, human.session, humanReport.cleanedNames, 'output', () => bridge.importInput(humanTarget, human.session, humanReport.cleanedNames, 'output'));
  assert.equal(humanImported.names.length, 1);
  humanReport = await manualSign(human, humanReport.id, 'H02', 'rejected', '展示格式不合要求，退回修改', '', '合成研究者');
  assert.equal(humanReport.status, 'rejected', 'An optional rejected item also returns the result');
  assert.equal(acceptance.load(human.session, human.id).acceptanceConfirmed, undefined);
  await assert.rejects(acceptance.importInput(humanTarget, human.session, humanReport.cleanedNames, 'output', () => { throw Error('must not import after human rejection'); }), /尚未最终确认/);
  humanReport = await manualSign(human, humanReport.id, 'H02', 'needs_evidence', '展示格式另补说明，属于可选检查', '', '合成研究者');
  assert.equal(humanReport.status, 'ready'); assert.equal(humanReport.summary.manualNeedsEvidence, 1);
  humanReport = await manualSign(human, humanReport.id, 'H01', 'needs_evidence', '统计范围还需核对字典说明', '', '合成研究者');
  assert.equal(humanReport.status, 'needs_manual');
  await assert.rejects(acceptance.confirm(human.session, human.id, humanReport.id, human.text), /必需人工核验未通过/);
  humanReport = await manualSign(human, humanReport.id, 'H01', 'rejected', '字典范围与结果不一致', '', '合成研究者');
  assert.equal(humanReport.status, 'rejected');
  humanReport = await manualSign(human, humanReport.id, 'H01', 'passed', '回原始字典核对，原先误读范围', '标准第2节；data第1行', '合成研究者');
  assert.equal(humanReport.manualChecks[0].history.length, 4);
  const publicReport = path.join(human.directory, 'clean-verification', humanReport.id, 'report.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(publicReport, 'utf8')).manualChecks, humanReport.manualChecks, 'Public report must include actual human records');
  const humanAgain = await acceptance.verify(human.session, human.id);
  assert.equal(humanAgain.status, 'ready'); assert.deepEqual(humanAgain.manualChecks[0].history, humanReport.manualChecks[0].history);
  assert.deepEqual(humanAgain.manualChecks[0].resolution, humanReport.manualChecks[0].resolution, 'Identical evidence can retain human conclusion');
  assert.ok(fs.existsSync(publicReport), 'Earlier reports remain available');
  fs.writeFileSync(path.join(human.directory, 'cleaned.csv'), human.original.toString().replace(/\n/g, '\r\n'));
  await assert.rejects(manualSign(human, humanAgain.id, 'H01', 'passed', '不能签已变更结果', '第1行', '合成研究者'), /文件或逐条依据发生变化/);
  const changedHuman = await acceptance.verify(human.session, human.id);
  assert.equal(changedHuman.status, 'needs_manual'); assert.equal(changedHuman.manualChecks[0].resolution, null);
  assert.deepEqual(changedHuman.manualChecks[0].history, humanReport.manualChecks[0].history, 'History survives but signatures are not reused when actual bytes change');
  const humanReference = bridge.download(human.session, 'reference', human.standardNames[0]); fs.chmodSync(humanReference, 0o644); fs.appendFileSync(humanReference, '\nchanged standard');
  await assert.rejects(manualSign(human, changedHuman.id, 'H01', 'passed', '不能签已变更标准', '第1行', '合成研究者'), /文件或逐条依据发生变化/);
  const changedStandard = await acceptance.verify(human.session, human.id);
  assert.equal(changedStandard.status, 'blocked'); assert.equal(changedStandard.manualChecks[0].resolution, null);
  assert.ok(changedStandard.issues.some(item => item.evidence.some(value => /标准原件在确认后发生改变/.test(value.detail || ''))));
  assert.deepEqual(fs.readFileSync(bridge.download(human.session, 'input', human.inputName)), human.original);
  assert.ok(fs.existsSync(bridge.download(humanTarget, 'input', humanImported.names[0])), 'Previously copied results are preserved');

  const engineHuman = await fixture({ text: manualText('本合成用例定义') });
  const engineHumanReport = await acceptance.verify(engineHuman.session, engineHuman.id);
  await manualSign(engineHuman, engineHumanReport.id, 'H01', 'passed', '合成测试已核对', '数据第1行', '合成研究者');
  const originalVersion = acceptance.engineVersion;
  try {
    acceptance.engineVersion = () => 'synthetic-updated-verifier-version';
    await assert.rejects(manualSign(engineHuman, engineHumanReport.id, 'H01', 'passed', '旧版本不能签', '第1行', '合成研究者'), /版本已变化/);
    const newEngineReport = await acceptance.verify(engineHuman.session, engineHuman.id);
    assert.equal(newEngineReport.status, 'needs_manual'); assert.equal(newEngineReport.manualChecks[0].resolution, null); assert.equal(newEngineReport.manualChecks[0].history.length, 1);
  } finally { acceptance.engineVersion = originalVersion; }

  const separate = await fixture({ text: manualText('本合成用例定义'), output: 'id,value,unit\nA,3,kg\n' });
  let separateReport = await acceptance.verify(separate.session, separate.id);
  const separateIssue = separateReport.issues.find(item => item.canAccept);
  separateReport = acceptance.decide(separate.session, separate.id, separateReport.id, separateIssue.id, 'accept', '合成自动检查例外已接受');
  assert.equal(separateReport.status, 'needs_manual', 'Accepting an automatic exception cannot replace mandatory manual verification');

  const tampered = await fixture(); const tamperedInput = bridge.download(tampered.session, 'input', tampered.inputName); fs.chmodSync(tamperedInput, 0o644); fs.writeFileSync(tamperedInput, 'id,value,unit\nA,99,kg\n');
  assert.equal((await acceptance.verify(tampered.session, tampered.id)).status, 'blocked');
  const old = bridge.createSession().id, oldId = randomUUID(), oldDir = path.join(bridge.session(old), 'output', oldId); fs.mkdirSync(oldDir); fs.writeFileSync(path.join(oldDir, 'old.csv'), 'id,v\nA,1\n');
  assert.equal(acceptance.runs(old)[0].status, 'legacy'); assert.equal(acceptance.get(old, oldId).status, 'not_checked');
  assert.equal((await acceptance.verify(old, oldId)).status, 'blocked'); assert.equal(acceptance.runs(old)[0].planText, null);
  assert.ok(fs.existsSync(path.join(oldDir, 'old.csv')));
  const damaged = await fixture(), privateFile = acceptance.recordFile(damaged.session, damaged.id);
  fs.writeFileSync(privateFile, '{damaged-record');
  assert.equal(acceptance.runs(damaged.session)[0].status, 'record_error');
  await assert.rejects(acceptance.verify(damaged.session, damaged.id), /缺少冻结/);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), '{damaged-record', 'Do not overwrite a damaged historical record with fabricated legacy metadata');
  const externalSession = bridge.createSession().id, externalId = randomUUID(), externalDir = path.join(bridge.session(externalSession), 'output', externalId); fs.mkdirSync(externalDir); fs.writeFileSync(path.join(externalDir, 'model.csv'), 'v\n5\n');
  const external = await acceptance.importInput(target, externalSession, [externalId + '/model.csv'], 'output', () => bridge.importInput(target, externalSession, [externalId + '/model.csv'], 'output')); assert.equal(external.names.length, 1, 'Do not classify an unrelated model result as a managed clean run');
  assert.equal(bridge.sourceBusy.size, 0); assert.equal(acceptance.pending.size, 0);
  console.log('CLEAN_ACCEPTANCE_TESTS_PASS (independent files, frozen rules/reference standards, manual signatures/history, recheck invalidation, hash/handoff gates, legacy preservation)');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  bridge.close();
  const resolved = path.resolve(root); if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('clean-acceptance-')) throw Error('Unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
