#!/usr/bin/env node
'use strict';

// Actual acceptance UI/actions + real Store in memory. No server, downloads,
// model call, user task, local data file, or research session is operated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/codex.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const names = ['downloadAcceptanceContext', 'downloadAcceptanceReport', 'downloadAcceptanceReady', 'downloadAcceptanceCanHandoff',
  'downloadAcceptanceVerifyBody', 'applyDownloadAcceptanceReport', 'loadDownloadAcceptance', 'decideDownloadAcceptance',
  'downloadAcceptanceArtifact', 'downloadAcceptancePanel', 'basisForDownload', 'handoffDownload', 'watchSourceDownload'];
function fn(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source); assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n  }', match.index) + 4);
}
function node(tag, text, className) {
  return { tag, textContent: text || '', className: className || '', children: [], open: false,
    append(...items) { this.children.push(...items); }, setAttribute(key, value) { this[key] = value; } };
}
const all = parent => [parent, ...(parent.children || []).flatMap(all)];
const text = parent => all(parent).map(item => item.textContent).join('\n');
const button = (parent, label) => all(parent).find(item => item.tag === 'button' && item.textContent === label);
const ready = () => ({ id: 'report-current', jobId: 'source-current', status: 'ready',
  summary: { currentRows: 12, baselineRows: 10, added: 2, removed: 0, revised: 0, schemaChanges: 0, unitChanges: 0, openDecisions: 0, blockingIssues: 0 },
  baseline: { jobId: 'source-old', label: '上次通过的2024年批次', mode: 'comparable' },
  checks: [{ id: 'sha', label: '本地文件完整性', status: 'passed', evidence: '大小和SHA与本批下载记录一致' }], issues: [],
  artifacts: [{ name: 'source-current/verification/report-current/report.json', label: '完整核验报告' }] });
const warning = () => ({ id: 'changed-rows', title: '源端修订了历史记录', severity: 'warning', decisionRequired: true, canAccept: true,
  impact: '2024年两条记录值发生变化', evidence: [{ label: '逐条差异', detail: '原值5，新值6', artifact: 'source-current/verification/report-current/diff.csv' }],
  attempts: ['已对照同口径旧版并核对官方发布时间'], recommendation: '确认是否采用本次官方修订，保留旧版。' });
const failure = () => ({ id: 'corrupt-file', title: '文件校验不一致', severity: 'error', decisionRequired: false, canAccept: true,
  impact: '当前字节与下载记录不一致，不能可靠交接', evidence: [{ label: 'SHA差异', detail: '与本批原始记录不符' }], attempts: [], recommendation: '恢复正确原件后重新核验。' });
function fixture(options = {}) {
  const memory = new Map(), browser = { localStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, String(value)) } };
  vm.runInNewContext(storeSource, { window: browser });
  const store = browser.Store, mod = store.addModule('下载数据');
  const plan = 'FAOSTAT TM 2024 小麦，全部报告国与贸易伙伴，进口和出口数量，保留原单位。';
  store.saveDoc(mod.id, plan); store.approveDoc(mod.id); store.markRun(mod.id, { artifacts: [{ name: 'batch.csv', size: 42 }] });
  Object.assign(mod, copy(store.getState().modules.find(item => item.id === mod.id)));
  const run = { label: '已审核下载方案', text: plan, sourceType: 'doc', sources: [{ url: 'https://fixture.invalid/batch.csv' }],
    files: [{ name: 'batch.csv', storedName: 'batch.csv', size: 42, sha256: 'fixture-sha', finalUrl: 'https://fixture.invalid/batch.csv' }], failures: [], confirmed: false,
    ...(!options.legacy ? { sourceJobId: 'source-current' } : {}) };
  const saved = { [mod.id]: { sessionId: 'source-session', download: run, ...(!options.legacy ? { sourceJobId: 'source-current' } : {}) } };
  const tasks = new Map([[mod.id, { busy: false, files: [], sourceJob: options.legacy ? null : { id: 'source-current', status: 'completed' } }]]);
  let report = options.report === null ? null : copy(options.report || ready()), globalBusy = false, hook = null, autoRender = false;
  const calls = [], actions = [], task = id => { if (!tasks.has(id)) tasks.set(id, { busy: false, files: [] }); return tasks.get(id); };
  const context = vm.createContext({ root: { ModuleSpace: { isBusy: () => globalBusy } }, ModuleSpace: { render() {} }, Store: store, task, saved, node,
    render() { if (autoRender && context.subject) context.subject.downloadAcceptancePanel(mod, task(mod.id)); }, persist() {},
    session: async id => { actions.push('session:' + id); saved[id] ||= {}; saved[id].sessionId ||= 'target-session'; return saved[id].sessionId; },
    request: async (url, settings = {}) => {
      const body = settings.body ? JSON.parse(settings.body) : null; calls.push({ url, body });
      if (hook) { const overridden = await hook(url, body); if (overridden !== undefined) return overridden; }
      if (url.startsWith('/api/codex/source/status?')) return { id: 'source-current', status: 'completed', kind: 'files', files: [], deliverables: copy(run.files),
        verification: report ? { id: report.id, status: report.status, summary: copy(report.summary || {}), baseline: copy(report.baseline || {}) } : null };
      if (url.startsWith('/api/codex/source/verification?')) return report && copy(report);
      if (url === '/api/codex/source/verify') { assert.equal(body.confirm, true); actions.push('verify'); return report && copy(report); }
      if (url === '/api/codex/source/verification/decision') {
        assert.equal(body.reportId, report.id); const issue = report.issues.find(item => item.id === body.issueId); assert.ok(issue);
        issue.resolution = { decision: body.decision, note: body.note };
        report.summary.openDecisions = report.issues.filter(item => item.decisionRequired && !item.resolution).length;
        report.status = body.decision === 'reject' ? 'rejected' : 'ready'; return copy(report);
      }
      if (url.startsWith('/api/codex/files?')) { actions.push('files'); return { files: [] }; }
      if (url === '/api/codex/import-input') {
        actions.push('import'); assert.equal(body.verificationReportId, report.id); assert.equal(body.sourceJobId, report.jobId);
        return { names: ['copied-batch.csv'], files: [{ name: 'copied-batch.csv', group: 'input', size: 42 }] };
      }
      throw new Error('Unexpected request (download/execution forbidden): ' + url);
    }
  });
  vm.runInContext(names.map(fn).join('\n') + '\nglobalThis.subject={' + names.join(',') + '};', context);
  const h = { subject: context.subject, store, mod, saved, run, calls, actions, context, task: () => task(mod.id),
    current: () => store.getState().modules.find(item => item.id === mod.id), setBusy: value => { globalBusy = value; },
    setAutoRender: value => { autoRender = value; },
    setHook: value => { hook = value; }, getReport: () => report, setReport: value => { report = value && copy(value); },
    bind(value) { report = value && copy(value); const scope = context.subject.downloadAcceptanceContext(mod); task(mod.id).sourceAcceptance = report;
      task(mod.id).sourceAcceptanceKey = scope.key; task(mod.id).sourceAcceptanceLoadedKey = scope.key; },
    panel() { return context.subject.downloadAcceptancePanel(mod, task(mod.id)); } };
  if (!options.legacy) h.bind(report);
  return h;
}
function noExecution(h) { assert.ok(!h.calls.some(call => /source\/(?:start|resume)|fetch-source|codex\/run/.test(call.url)), 'Never download or execute during local verification'); }
function manualDownloadDialog(h, sources) {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '' }); return elements.get(id); };
  get('download-sources').value = sources.map(item => item.url).join('\n');
  h.context.document = { getElementById: get }; h.context.URL = URL;
  const start = source.indexOf("  document.getElementById('download-start').onclick = async () => {");
  const end = source.indexOf('  async function handoffDownload(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext('let downloadModuleId=Store.getState().modules[0].id, downloadBasis=basisForDownload(Store.getState().modules[0]);\n'
    + ['parseDownloadSources', 'updateDownloadForm'].map(fn).join('\n') + '\n' + source.slice(start, end), h.context);
  return { start: () => get('download-start').onclick(), get };
}
async function main() {
  const normal = fixture(), docBefore = copy(normal.current().doc), panel = normal.panel();
  assert.match(text(panel), /核验已就绪，仍待本批统一确认/); assert.match(text(panel), /新增 2/); assert.match(text(panel), /比较基准：上次通过/);
  const fold = all(panel).find(item => item.className === 'download-acceptance-normal'); assert.equal(fold.open, false);
  assert.equal(all(panel).filter(item => item.className === 'download-acceptance-issue').length, 0); assert.equal(normal.calls.length, 0);
  assert.equal(normal.subject.downloadAcceptanceCanHandoff(normal.mod, normal.task()), true); assert.equal(normal.current().run.status, 'ran');
  assert.deepEqual(copy(normal.current().doc), docBefore); assert.equal(normal.run.confirmed, false, 'Ready report is not unified user acceptance');
  assert.ok(all(panel).some(item => item.tag === 'a' && item.href.includes('group=output') && item.href.includes(encodeURIComponent('source-current/verification/report-current/report.json'))));
  const projected = fixture();
  projected.task().sourceJob.verification = { id: 'report-current', status: 'ready', summary: ready().summary, baseline: ready().baseline, reportName: 'source-current/report.json' };
  delete projected.task().sourceAcceptance; delete projected.task().sourceAcceptanceKey; delete projected.task().sourceAcceptanceLoadedKey;
  assert.equal(projected.subject.downloadAcceptanceReport(projected.mod, projected.task()), null, 'A job summary is not a full report or an acceptance gate');
  assert.equal(projected.subject.downloadAcceptanceCanHandoff(projected.mod, projected.task()), false);
  projected.panel();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(projected.calls.length, 1); assert.ok(projected.calls[0].url.includes('/source/verification?'));
  assert.equal(projected.calls[0].body, null, 'The visible card fetches the full report through GET only');
  assert.equal(projected.subject.downloadAcceptanceCanHandoff(projected.mod, projected.task()), true);
  const notChecked = { jobId: 'source-current', status: 'not_checked', checks: [], issues: [], artifacts: [], summary: {} };
  const unchecked = fixture({ report: notChecked }); await unchecked.subject.loadDownloadAcceptance(unchecked.mod);
  assert.equal(unchecked.task().sourceAcceptance, null); assert.equal(unchecked.task().sourceAcceptanceError, '');
  assert.match(text(unchecked.panel()), /尚无完整验收报告/); assert.equal(button(unchecked.panel(), '核验已有文件').disabled, false);
  assert.equal(unchecked.calls.filter(call => call.body).length, 0, 'not_checked is recoverable and never automatically triggers POST');
  const empty = fixture({ legacy: true }); empty.run.files = [];
  assert.match(text(empty.panel()), /暂无本批文件/); assert.doesNotMatch(text(empty.panel()), /旧文件/);
  assert.equal(button(empty.panel(), '核验已有文件').disabled, true); assert.equal(empty.calls.length, 0);

  // A previously fetched checking/not_checked state cannot stick after the
  // source-status watcher observes terminal completion and a final summary.
  for (const previous of [notChecked, { ...ready(), status: 'checking' }]) {
    const finished = fixture({ report: previous }); await finished.subject.loadDownloadAcceptance(finished.mod);
    finished.setReport(ready()); finished.setAutoRender(true);
    await finished.subject.watchSourceDownload(finished.mod.id, 'source-current');
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(finished.subject.downloadAcceptanceReport(finished.mod, finished.task()).status, 'ready');
    assert.equal(finished.calls.filter(call => call.url.includes('/source/verification?')).length, 2, 'Completion must GET the final full report again');
    assert.equal(finished.calls.some(call => call.body), false, 'Refreshing final verification never automatically POSTs verify');
    noExecution(finished);
  }
  let releaseOld; const lateRead = fixture(); let oldPending = true;
  lateRead.setHook(url => url.includes('/source/verification?') && oldPending ? new Promise(resolve => { oldPending = false; releaseOld = resolve; }) : undefined);
  const staleRead = lateRead.subject.loadDownloadAcceptance(lateRead.mod);
  lateRead.setAutoRender(true); await lateRead.subject.watchSourceDownload(lateRead.mod.id, 'source-current');
  releaseOld({ ...ready(), status: 'checking' }); await staleRead;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(lateRead.subject.downloadAcceptanceReport(lateRead.mod, lateRead.task()).status, 'ready', 'A late old checking response cannot overwrite terminal invalidation');
  assert.equal(lateRead.calls.filter(call => call.url.includes('/source/verification?')).length, 2);
  assert.equal(lateRead.calls.some(call => call.body), false); noExecution(lateRead);
  const yearReport = ready(); yearReport.summary.addedYears = [2025]; yearReport.summary.missingYears = [2022];
  const yearOverview = fixture({ report: yearReport }); assert.match(text(yearOverview.panel()), /新增年份：2025/); assert.match(text(yearOverview.panel()), /缺失年份：2022/);

  const problematic = ready(); problematic.status = 'blocked'; problematic.summary.openDecisions = 1; problematic.summary.blockingIssues = 1;
  problematic.issues = [warning(), failure(), { id: 'informational', title: '首次获取提示', severity: 'warning', decisionRequired: false, impact: '无需重复确认的记录' }];
  const issues = fixture({ report: problematic }), issuePanel = issues.panel(); assert.equal(issues.subject.downloadAcceptanceCanHandoff(issues.mod, issues.task()), false);
  const cards = all(issuePanel).filter(item => item.className === 'download-acceptance-issue'); assert.equal(cards.length, 2, 'Only decisions and blocking errors are prominent');
  for (const phrase of ['问题：源端修订了历史记录', '影响：2024年两条', '逐条差异：原值5，新值6', '已尝试：已对照', '建议：确认是否采用', '需要你决定']) assert.match(text(cards[0]), new RegExp(phrase));
  assert.ok(button(cards[0], '接受本次变化/缺口')); assert.ok(button(cards[0], '退回处理'));
  assert.equal(button(cards[1], '接受本次变化/缺口'), undefined, 'Even canAccept:true cannot override severity:error'); assert.match(text(cards[1]), /不能强行接受/);
  const beforeInvalid = issues.calls.length;
  assert.equal(await issues.subject.decideDownloadAcceptance(issues.mod, problematic.id, 'corrupt-file', 'accept', '想跳过'), false);
  assert.equal(await issues.subject.decideDownloadAcceptance(issues.mod, 'stale-report', 'changed-rows', 'accept', '已有依据'), false);
  assert.equal(await issues.subject.decideDownloadAcceptance(issues.mod, problematic.id, 'changed-rows', 'accept', ''), false);
  assert.equal(issues.calls.length, beforeInvalid); assert.match(issues.task().sourceAcceptanceError, /理由/);
  assert.equal(issues.subject.downloadAcceptanceArtifact(issues.mod, '../outside.txt'), null);
  assert.equal(issues.subject.downloadAcceptanceArtifact(issues.mod, 'https://external.invalid/x'), null);

  const choiceReport = ready(); choiceReport.status = 'needs_decision'; choiceReport.summary.openDecisions = 1; choiceReport.issues = [warning()];
  const choice = fixture({ report: choiceReport }), choiceBefore = copy(choice.current()), choiceCard = all(choice.panel()).find(item => item.className === 'download-acceptance-issue');
  const note = all(choiceCard).find(item => item.tag === 'textarea'); note.value = '已核对官方说明，接受本次两条历史修订'; note.oninput();
  await button(choiceCard, '接受本次变化/缺口').onclick();
  assert.deepEqual(choice.calls[0].body, { sessionId: 'source-session', id: 'source-current', reportId: 'report-current', issueId: 'changed-rows', decision: 'accept', note: note.value });
  assert.equal(choice.subject.downloadAcceptanceCanHandoff(choice.mod, choice.task()), true); assert.deepEqual(copy(choice.current()), choiceBefore);
  assert.equal(choice.run.confirmed, false); assert.equal(choice.store.getState().modules.length, 1, 'Issue decision does not hand off or create a clean module');
  assert.equal(all(choice.panel()).filter(item => item.className === 'download-acceptance-issue').length, 0, 'Accepted warning moves into folded records');
  const rejected = fixture({ report: choiceReport }); await rejected.subject.decideDownloadAcceptance(rejected.mod, 'report-current', 'changed-rows', 'reject', '尚无足够依据');
  assert.equal(rejected.subject.downloadAcceptanceCanHandoff(rejected.mod, rejected.task()), false); assert.match(text(rejected.panel()), /已退回：尚无足够依据/);
  const stale = fixture({ report: choiceReport }); stale.setHook(url => { if (url.endsWith('/decision')) throw new Error('报告已变更，请刷新'); });
  assert.equal(await stale.subject.decideDownloadAcceptance(stale.mod, 'report-current', 'changed-rows', 'accept', '有依据'), false);
  assert.match(stale.task().sourceAcceptanceError, /报告已变更/); assert.equal(stale.run.confirmed, false);

  const missing = fixture({ report: null }); assert.match(text(missing.panel()), /尚无完整验收报告/); assert.equal(missing.subject.downloadAcceptanceCanHandoff(missing.mod, missing.task()), false);
  await missing.subject.loadDownloadAcceptance(missing.mod); assert.equal(missing.calls.length, 1); assert.ok(missing.calls[0].url.includes('/source/verification?'));
  assert.equal(missing.calls[0].body, null); assert.equal(missing.task().sourceAcceptance, null, 'GET does not initiate verification or download');
  let release;
  const waiting = fixture(); waiting.setHook(url => url === '/api/codex/source/verify' ? new Promise(resolve => { release = resolve; }) : undefined);
  const pending = waiting.subject.loadDownloadAcceptance(waiting.mod, true); assert.equal(waiting.task().sourceAcceptanceBusy, true);
  assert.equal(waiting.subject.downloadAcceptanceCanHandoff(waiting.mod, waiting.task()), false); assert.match(text(waiting.panel()), /正在读取或核验已有本地文件/);
  assert.equal(button(waiting.panel(), '核验已有文件').disabled, true);
  await waiting.subject.handoffDownload(waiting.mod); assert.equal(waiting.calls.filter(call => call.url.includes('import-input')).length, 0);
  release(ready()); await pending; assert.equal(waiting.task().sourceAcceptanceBusy, false);

  for (const failedReport of [null, { ...ready(), status: 'needs_decision', issues: [warning()], summary: { openDecisions: 1 } },
    { ...ready(), status: 'ready', issues: [failure()] }, { ...ready(), status: 'checking' }]) {
    const blocked = fixture({ report: failedReport }); await blocked.subject.handoffDownload(blocked.mod);
    assert.equal(blocked.store.getState().modules.length, 1, 'Verify before creating a receiving module'); assert.equal(blocked.run.confirmed, false);
    assert.equal(blocked.actions.some(action => action.startsWith('session:') || action === 'import'), false);
    assert.ok(blocked.task().error); noExecution(blocked);
  }
  const handoff = fixture(), handoffDocBefore = copy(handoff.current().doc); await handoff.subject.handoffDownload(handoff.mod);
  assert.equal(handoff.calls[0].url, '/api/codex/source/verify'); assert.equal(handoff.actions[0], 'verify');
  assert.equal(handoff.run.confirmed, true); assert.equal(handoff.current().run.status, 'confirmed');
  const clean = handoff.store.getState().modules.find(item => item.type === 'clean-data'); assert.ok(clean);
  assert.deepEqual(copy(handoff.saved[clean.id].inputBatch.verification), { sourceJobId: 'source-current', reportId: 'report-current' });
  assert.deepEqual(copy(handoff.current().doc), handoffDocBefore); noExecution(handoff);

  const legacy = fixture({ legacy: true }), legacyRun = legacy.run, legacyBefore = copy(legacy.run);
  const legacyPanel = legacy.panel(); assert.match(text(legacyPanel), /旧文件尚无验收报告/); assert.equal(legacy.calls.length, 0);
  await button(legacyPanel, '核验已有文件').onclick();
  assert.deepEqual(legacy.calls[0].body, { sessionId: 'source-session', confirm: true, rules: legacy.run.text, names: ['batch.csv'], sources: legacy.run.sources });
  assert.equal(legacy.saved[legacy.mod.id].download, legacyRun, 'Bind the original record without replacing it');
  assert.equal(legacy.run.sourceJobId, 'source-current'); assert.equal(legacy.saved[legacy.mod.id].sourceJobId, 'source-current');
  assert.deepEqual(copy({ ...legacy.run, sourceJobId: undefined }), legacyBefore); assert.equal(legacy.run.confirmed, false); noExecution(legacy);

  // The actual legacy dialog starts a separate local batch. Its old backend
  // binding cannot leak into verification, and automatic verification follows
  // full success only, after the download busy flag is released.
  const manual = fixture(), originalManualRun = manual.run, originalManualBytes = copy(manual.run), originalManualDoc = copy(manual.current().doc);
  manual.saved[manual.mod.id].sourceBasis = { text: 'old source basis' };
  manual.task().sourceAcceptanceQueuedKey = 'old queued'; manual.task().sourceAcceptanceError = 'old error';
  const manualReport = { ...ready(), id: 'new-local-report', jobId: 'new-local-source' };
  const manualDialog = manualDownloadDialog(manual, [{ url: 'https://fixture.invalid/new-batch.csv' }]);
  manual.setHook((url, body) => {
    if (url === '/api/codex/fetch-source') {
      assert.equal(manual.saved[manual.mod.id].sourceJobId, undefined); assert.equal(manual.saved[manual.mod.id].sourceBasis, undefined);
      assert.equal(manual.task().sourceJob, null); assert.equal(manual.task().sourceAcceptance, null);
      assert.equal(manual.task().sourceAcceptanceLoadedKey, null); assert.equal(manual.task().sourceAcceptanceQueuedKey, null);
      return { download: { storedName: 'new-batch.csv', name: 'new-batch.csv', size: 43 }, files: [] };
    }
    if (url === '/api/codex/source/verify') {
      assert.equal(manual.task().busy, false, 'Release download busy before local verification');
      assert.deepEqual(body, { sessionId: 'source-session', confirm: true, rules: originalManualRun.text, names: ['new-batch.csv'], sources: [{ url: 'https://fixture.invalid/new-batch.csv', name: '' }] });
      return manualReport;
    }
  });
  await manualDialog.start();
  assert.equal(manual.calls.filter(call => call.url === '/api/codex/source/verify').length, 1);
  assert.equal(manual.saved[manual.mod.id].sourceJobId, 'new-local-source'); assert.equal(manual.saved[manual.mod.id].download.confirmed, false);
  assert.equal(manual.subject.downloadAcceptanceReport(manual.mod, manual.task()).id, 'new-local-report');
  assert.deepEqual(copy(originalManualRun), originalManualBytes, 'A new batch leaves the previous file record unchanged');
  assert.deepEqual(copy(manual.current().doc), originalManualDoc); assert.equal(manual.current().run.status, 'ran');
  assert.equal(manual.store.getState().modules.length, 1); assert.match(manualDialog.get('download-status').textContent, /仍需本批统一确认/);
  assert.equal(manual.calls.some(call => /source\/(?:start|resume)|import-input|codex\/run/.test(call.url)), false);

  const partial = fixture(), partialDialog = manualDownloadDialog(partial, [{ url: 'https://fixture.invalid/one.csv' }, { url: 'https://fixture.invalid/two.csv' }]);
  partial.setHook((url, body) => { if (url === '/api/codex/fetch-source') { if (body.source.url.endsWith('/two.csv')) throw new Error('fixture failed'); return { download: { storedName: 'one.csv', size: 1 }, files: [] }; } });
  await partialDialog.start();
  assert.equal(partial.saved[partial.mod.id].download.files.length, 1); assert.equal(partial.saved[partial.mod.id].download.failures.length, 1);
  assert.equal(partial.saved[partial.mod.id].sourceJobId, undefined); assert.equal(partial.task().sourceJob, null);
  assert.equal(partial.current().run, null, 'Partial files are retained without marking the batch completed');
  assert.equal(partial.calls.filter(call => call.url === '/api/codex/source/verify').length, 0);
  assert.match(partialDialog.get('download-status').textContent, /下载尚未完成.*失败项仍待处理/);
  assert.equal(partial.subject.downloadAcceptanceCanHandoff(partial.mod, partial.task()), false);

  let releasePrevious, releaseNew;
  const inFlight = fixture(); let firstRead = true;
  inFlight.setHook(url => {
    if (url.includes('/source/verification?') && firstRead) { firstRead = false; return new Promise(resolve => { releasePrevious = resolve; }); }
    if (url === '/api/codex/fetch-source') return { download: { storedName: 'next.csv', size: 1 }, files: [] };
    if (url === '/api/codex/source/verify') return new Promise(resolve => { releaseNew = resolve; });
  });
  const previousRead = inFlight.subject.loadDownloadAcceptance(inFlight.mod);
  const inFlightDialog = manualDownloadDialog(inFlight, [{ url: 'https://fixture.invalid/next.csv' }]), nextDownload = inFlightDialog.start();
  for (let i = 0; i < 16 && !releaseNew; i++) await Promise.resolve();
  assert.ok(releaseNew); assert.equal(inFlight.task().sourceAcceptanceBusy, true);
  releasePrevious(ready()); await previousRead;
  assert.equal(inFlight.task().sourceAcceptanceBusy, true, 'A late previous batch request cannot release the current verification lock');
  assert.equal(inFlight.subject.downloadAcceptanceReport(inFlight.mod, inFlight.task()), null);
  releaseNew(manualReport); await nextDownload;
  assert.equal(inFlight.subject.downloadAcceptanceReport(inFlight.mod, inFlight.task()).id, 'new-local-report');

  let oldResolve; const switched = fixture(); switched.setHook(url => url.includes('/verification?') ? new Promise(resolve => { oldResolve = resolve; }) : undefined);
  const oldRead = switched.subject.loadDownloadAcceptance(switched.mod); switched.saved[switched.mod.id].sourceJobId = 'new-source'; switched.run.sourceJobId = 'new-source'; switched.task().sourceJob = { id: 'new-source', status: 'completed' };
  oldResolve(ready()); await oldRead; assert.equal(switched.subject.downloadAcceptanceReport(switched.mod, switched.task()), null, 'An old report cannot attach to a newly selected batch');
  for (const h of [normal, projected, unchecked, empty, yearOverview, issues, choice, rejected, stale, missing, waiting, legacy, switched]) noExecution(h);
  console.log('DOWNLOAD_ACCEPTANCE_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
