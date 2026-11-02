#!/usr/bin/env node
'use strict';
// Production history click handlers, real workspace manager, fake DOM/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8');
const source = read('codex.js'), clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fn(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '('); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
class Element {
  constructor(tag, text, cls) { this.tagName = tag.toUpperCase(); this.textContent = text || ''; this.className = cls || ''; this.children = []; this.parentNode = null; this.open = false; }
  append(...items) { items.forEach(item => { item.parentNode = this; this.children.push(item); }); }
  replaceChildren(...items) { this.children.forEach(item => { item.parentNode = null; }); this.children = []; this.append(...items); }
  setAttribute(key, value) { this[key] = value; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
  close() { this.open = false; this.onclose?.(); }
  showModal() { this.open = true; }
  focus() { this.focused = true; }
}
const all = element => [element, ...element.children.flatMap(all)];
const text = element => all(element).map(item => item.textContent).join('\n');
const button = (element, label) => all(element).find(item => item.tagName === 'BUTTON' && item.textContent === label);
const MODULE = 'module-fixture', KEY = 'research_codex_tasks_v1';
const job = { id: '9bc7ca34-9ec0-4c94-bcc8-8780189ff10f', status: 'cancelled', stage: 'discover', until: 'discover',
  config: { topic: 'Archived research', query: 'frozen query', sources: ['cnki'], sourceQueries: { cnki: 'archived source query' } },
  createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z', count: 155,
  message: 'Researcher stopped this run', files: ['candidates.csv', 'candidates.json', 'rule-review-confirmed.json'], events: [{ at: '2026-10-20T01:00:00.000Z', stage: 'discover', message: 'Saved candidates' }] };
const FUNCTIONS = ['literatureWorkspaceBusy', 'commitLiteratureRevision', 'attachLiteratureHistoryContext', 'closeLiteratureHistoryDetails',
  'continueLiteratureHistoryDiscussion',
  'literatureHistoryDetailsCurrent', 'renderLiteratureHistoryDetails', 'loadLiteratureHistoryDetails', 'openLiteratureHistoryDetails',
  'reviseLiteratureConfiguration', 'literatureDeliverableSummary', 'literatureStatusText', 'literatureProcessingBasisMessage', 'literatureFileLabel', 'literatureFileGroups', 'literatureDeliverables', 'literatureHistory'];
function harness() {
  let project = 'project-fixture', busy = false, t, latest = clone(job), deferred = null, failRead = false, failLoad = false, failSync = false, idSequence = 0, importedReview = null;
  let state = { activeModuleId: MODULE, modules: [{ id: MODULE, type: 'literature-mining', name: '文献挖掘', messages: [{ role: 'user', text: 'New discussion remains' }] }] };
  const storage = new Map(), writes = [], calls = [], frozenCalls = [], reviewOpens = [], discussionOpens = [], body = new Element('body');
  const savedInitial = { sessionId: 'original-session', literatureJobId: job.id, literatureConfig: { topic: 'New draft', query: 'NEW DRAFT', sources: ['pubmed'] }, literatureUntil: 'export' };
  const makeTask = client => ({ literatureConfig: clone(client.literatureConfig), literatureUntil: client.literatureUntil, literatureJob: clone(job),
    literatureJobs: [clone(job)], literatureJobsTried: true, literatureJobsLoading: false, literatureBusy: false, busy: false });
  t = makeTask(savedInitial);
  const browser = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { writes.push(key); storage.set(key, String(value)); }, removeItem: key => { writes.push(key); storage.delete(key); } },
    crypto: { randomUUID: () => 'context-' + ++idSequence }, TaskManager: { currentTaskId: () => project, snapshotModuleRules: () => null, restoreModuleRules: () => true },
    Store: { getState: () => clone(state), restoreState: next => { state = clone(next); return true; } },
    ModuleSpace: { isBusy: () => busy, snapshotContext: () => ({ draftText: 'Preserved chat draft' }), resetContext: () => true, render() {} },
    LiteratureUI: { isBusy: () => false, snapshotContext: () => null, restoreContext: () => true },
    LiteratureRuleReview: { openFrozenJob: async (id, options) => { frozenCalls.push({ id, options }); return { readOnly: true }; } },
    LiteratureDiscussions: { open: async id => discussionOpens.push(id) } };
  const context = vm.createContext({ window: browser, root: browser, saved: { [MODULE]: clone(savedInitial) }, key: KEY, task: () => t,
    node: (tag, value, cls) => new Element(tag, value, cls), document: { body }, Store: browser.Store, ModuleSpace: browser.ModuleSpace, localStorage: browser.localStorage,
    render() {}, loadLiteratureJobs: async () => {}, changeLiteratureHistory: async () => {}, literatureStageLabel: value => value,
    sameLiteratureConfig: (a, b) => JSON.stringify(a) === JSON.stringify(b), literatureSource: mod => JSON.stringify(mod.messages),
    session: async () => { if (!context.saved[MODULE].sessionId) context.saved[MODULE].sessionId = 'new-target-session'; return context.saved[MODULE].sessionId; },
    openLiteratureRuleReview: async () => { reviewOpens.push(clone(t)); },
    LITERATURE_STATUS_LABELS: { cancelled: '已停止', running: '进行中' }, LITERATURE_SOURCE_LABELS: { cnki: '中国知网' },
    LITERATURE_FILE_LABELS: { 'candidates.csv': '候选清单 CSV（累计）', 'candidates.json': '候选清单 JSON（累计）', 'rule-review-confirmed.json': '已确认配置与逐项核查记录' }, LITERATURE_FILE_GROUPS: [['export', '导出产物']],
    request: async (url, options = {}) => { const data = options.body ? JSON.parse(options.body) : null; calls.push({ url, method: options.method || 'GET', body: data });
      if (url === '/api/literature/rule-review/fork') {
        assert.equal(data.fromHistory, true, 'Only an explicit import can move a historical run to a new workspace');
        importedReview = { id: 'review-fixture', revision: 1, sessionId: data.sessionId, workspaceId: data.workspaceId, parentJobId: data.jobId,
          config: clone(job.config), until: job.until, source: data.source, context: clone(data.context), ready: false,
          items: Array.from({ length: 14 }, (_, index) => ({ id: 'item-' + index, status: 'pending' })), progress: { confirmed: 0, total: 14 } };
        return clone(importedReview);
      }
      if (url === '/api/literature/rule-review/action') {
        if (failSync) throw new Error('Fixture sync failed');
        assert.equal(data.action, 'sync'); importedReview = { ...importedReview, revision: 2, config: clone(data.config), until: data.until }; return clone(importedReview);
      }
      if (!url.startsWith('/api/literature/job?id=')) throw new Error('Unexpected route ' + url);
      if (failRead) throw new Error('Fixture archived run unavailable'); return deferred || clone(latest);
    } });
  vm.runInContext(read('literature-task-workspaces.js'), context);
  const manager = browser.LiteratureTaskWorkspaces.createManager({ moduleId: MODULE, adapter: {
    snapshotClient: () => ({ ...clone(context.saved[MODULE]), literatureConfig: clone(t.literatureConfig), literatureUntil: t.literatureUntil }),
    applyClient: client => { context.saved = { [MODULE]: clone(client) }; t = makeTask(client); return true; }, isBusy: () => busy
  } });
  assert.equal(manager.ensure().ok, true); assert.equal(manager.saveActive().ok, true);
  context.literatureWorkspaceManager = () => failLoad ? { saveActive: () => ({ ok: false, error: 'Fixture could not preserve workspace' }) } : manager;
  vm.runInContext('let literatureHistoryDetailsDialog=null;\n' + FUNCTIONS.map(fn).join('\n') + '\nglobalThis.subject={' + FUNCTIONS.join(',') + '};', context);
  writes.length = 0;
  return { context, subject: context.subject, manager, body, calls, writes, frozenCalls, reviewOpens, discussionOpens, storage,
    get t() { return t; }, get saved() { return context.saved[MODULE]; }, get mod() { return clone(state.modules[0]); }, get state() { return clone(state); },
    get dialog() { return body.children.find(item => item.tagName === 'DIALOG'); },
    setBusy: value => { busy = value; }, setReadError: value => { failRead = value; }, setLoadError: value => { failLoad = value; }, setSyncError: value => { failSync = value; }, setLatest: value => { latest = clone(value); },
    deferRead: value => { deferred = value; }, setProject: value => { project = value; },
    replaceTask: () => { t = makeTask(savedInitial); },
    async clickView() { const panel = this.subject.literatureHistory(this.mod, t); const view = button(panel, '查看'); assert.ok(view && !view.disabled, 'Read-only history is available while work is busy'); await view.onclick(); }
  };
}
async function main() {
  const h = harness(), originalDraft = JSON.stringify(h.t.literatureConfig), originalChat = JSON.stringify(h.state), originalSaved = JSON.stringify(h.saved), active = h.manager.active().id;
  await h.clickView();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET'); assert.equal(h.calls[0].url, '/api/literature/job?id=' + job.id);
  assert.match(text(h.dialog), /Archived research/); assert.match(text(h.dialog), /155/); assert.match(text(h.dialog), /Researcher stopped/);
  assert.ok(all(h.dialog).filter(item => item.tagName === 'A').some(link => link.textContent === '候选清单 CSV（累计）' && link.href.includes('name=candidates.csv')));
  assert.equal(h.manager.active().id, active); assert.equal(JSON.stringify(h.saved), originalSaved); assert.equal(h.writes.length, 0);
  button(h.dialog, '查看启动时的已确认配置').onclick(); assert.equal(h.frozenCalls[0].id, job.id); assert.equal(h.frozenCalls[0].options.onApply, undefined); assert.equal(h.frozenCalls[0].options.onRevise, undefined);
  button(h.dialog, '关闭').onclick(); assert.equal(h.dialog, undefined); assert.equal(h.writes.length, 0); assert.equal(JSON.stringify(h.t.literatureConfig), originalDraft); assert.equal(JSON.stringify(h.state), originalChat);
  h.setBusy(true); await h.clickView(); assert.equal(button(h.dialog, '载入此任务到工作区').disabled, true); assert.match(text(h.dialog), /可以只读查看/); assert.equal(h.writes.length, 0);
  h.setBusy(false); await button(h.dialog, '刷新详情').onclick(); button(h.dialog, '载入此任务到工作区').onclick();
  assert.match(text(h.dialog), /已载入这次任务/); assert.equal(JSON.stringify(h.t.literatureConfig), originalDraft, 'Loading the same saved run must not overwrite a newer draft with frozen query');
  assert.equal(h.t.literatureUntil, 'export'); assert.equal(JSON.stringify(h.state), originalChat); assert.ok(h.writes.length > 0, 'Only explicit loading saves a workspace binding');
  const failed = harness(); await failed.clickView(); failed.setLoadError(true); button(failed.dialog, '载入此任务到工作区').onclick();
  assert.match(text(failed.dialog), /Fixture could not preserve workspace/); assert.equal(failed.t.literatureConfig.query, 'NEW DRAFT');
  const error = harness(); error.setReadError(true); await error.clickView(); assert.match(text(error.dialog), /历史详情读取失败.*Fixture archived run unavailable/); assert.ok(button(error.dialog, '刷新详情')); assert.equal(error.writes.length, 0);
  error.setReadError(false); await button(error.dialog, '刷新详情').onclick(); assert.match(text(error.dialog), /155/);
  const empty = harness(); empty.setLatest({ ...job, status: 'running', files: [] }); await empty.clickView(); assert.match(text(empty.dialog), /仍在运行/); assert.match(text(empty.dialog), /此轮尚未产生结果文件/); assert.equal(empty.calls.length, 1);
  const late = harness(); let finish; late.deferRead(new Promise(resolve => { finish = resolve; })); const viewing = late.clickView();
  const closing = late.dialog; button(closing, '关闭').onclick(); finish(clone(job)); await viewing; assert.equal(late.dialog, undefined); assert.equal(late.writes.length, 0);
  const switched = harness(); let finishSwitch; switched.deferRead(new Promise(resolve => { finishSwitch = resolve; })); const oldView = switched.clickView();
  switched.setProject('different-project'); switched.replaceTask(); finishSwitch(clone(job)); await oldView;
  assert.match(text(switched.dialog), /工作区已切换/); assert.ok(!text(switched.dialog).includes('Archived research')); assert.equal(switched.t.literatureConfig.query, 'NEW DRAFT'); assert.equal(switched.writes.length, 0);
  assert.ok([h, failed, error, empty, late, switched].every(test => test.calls.every(call => call.method === 'GET' && call.url.startsWith('/api/literature/job?'))), 'View/load never starts, resumes, watches or opens a research browser');
  const discuss = harness(), discussWorkspace = discuss.manager.active().id;
  await discuss.clickView(); assert.ok(button(discuss.dialog, '继续讨论并更新规则'));
  button(discuss.dialog, '继续讨论并更新规则').onclick();
  assert.equal(discuss.dialog, undefined); assert.equal(discuss.manager.active().id, discussWorkspace);
  assert.equal(discuss.saved.literatureDiscussionEditingForJobId, job.id);
  assert.equal(discuss.t.literatureConfig.query, 'NEW DRAFT');
  assert.equal(discuss.mod.messages[0].text, 'New discussion remains');
  assert.equal(discuss.calls.length, 1, 'Continuing discussion does not fork, generate, search or resume');
  const discussingBusy = harness(); discussingBusy.setBusy(true); await discussingBusy.clickView();
  assert.equal(button(discussingBusy.dialog, '继续讨论并更新规则').disabled, true);
  const missingDiscussion = harness(); missingDiscussion.saved.literatureJobId = 'other-run'; missingDiscussion.t.literatureJob = { ...clone(job), id: 'other-run' };
  missingDiscussion.manager.saveActive(); const preservedDiscussion = missingDiscussion.manager.active().id;
  await missingDiscussion.clickView(); button(missingDiscussion.dialog, '继续讨论并更新规则').onclick();
  assert.equal(missingDiscussion.dialog, undefined); assert.deepEqual(missingDiscussion.discussionOpens, [MODULE]);
  assert.equal(missingDiscussion.mod.messages.length, 0, 'No invented complete chat when the historical workspace was absent');
  assert.equal(missingDiscussion.manager.snapshot(preservedDiscussion).snapshot.module.messages[0].text, 'New discussion remains');
  const migrated = harness(); await migrated.clickView(); button(migrated.dialog, '载入此任务到工作区').onclick();
  assert.ok(button(migrated.dialog, '继续逐项核查当前草稿'), 'History load exposes a visible route back to the latest draft review');
  await button(migrated.dialog, '继续逐项核查当前草稿').onclick();
  assert.equal(migrated.calls[1].url, '/api/literature/rule-review/fork'); assert.equal(migrated.calls[1].body.fromHistory, true);
  assert.equal(migrated.calls[1].body.workspaceId, migrated.manager.active().id); assert.equal(migrated.calls[1].body.context.messages[0].text, 'New discussion remains');
  assert.equal(migrated.calls[2].body.action, 'sync'); assert.equal(migrated.calls[2].body.config.query, 'NEW DRAFT'); assert.equal(migrated.calls[2].body.until, 'export');
  assert.equal(migrated.reviewOpens[0].literatureConfig.query, 'NEW DRAFT'); assert.equal(migrated.t.literatureConfig.query, 'NEW DRAFT'); assert.equal(migrated.t.literatureJob, null);
  assert.equal(migrated.saved.literatureRevisionOriginal.job.id, job.id); assert.equal(migrated.saved.literatureRuleReview.progress.confirmed, 0);
  assert.equal(migrated.saved.literatureReviewAppliedRevision, undefined); assert.equal(migrated.dialog, undefined); assert.equal(migrated.calls.length, 3, 'History→load→fork→sync→review never searches or resumes the old checkpoint');
  const syncFailed = harness(); await syncFailed.clickView(); button(syncFailed.dialog, '载入此任务到工作区').onclick(); syncFailed.setSyncError(true);
  await button(syncFailed.dialog, '继续逐项核查当前草稿').onclick(); assert.equal(syncFailed.t.literatureJob.id, job.id); assert.equal(syncFailed.t.literatureConfig.query, 'NEW DRAFT');
  assert.match(syncFailed.t.literatureError, /Fixture sync failed/); assert.equal(syncFailed.reviewOpens.length, 0);
  const unknownWorkspace = harness(); unknownWorkspace.saved.literatureJobId = 'another-run'; unknownWorkspace.t.literatureJob = { ...clone(job), id: 'another-run' }; unknownWorkspace.manager.saveActive();
  const previousWorkspaceId = unknownWorkspace.manager.active().id;
  await unknownWorkspace.clickView(); button(unknownWorkspace.dialog, '载入此任务到工作区').onclick();
  assert.notEqual(unknownWorkspace.manager.active().id, previousWorkspaceId); assert.equal(unknownWorkspace.saved.sessionId, undefined, 'An unknown historical run gets a separate workspace, never a forged old session');
  unknownWorkspace.t.literatureConfig.query = 'LATEST PREPARED DRAFT'; unknownWorkspace.saved.literatureConfig = clone(unknownWorkspace.t.literatureConfig);
  await button(unknownWorkspace.dialog, '刷新详情').onclick(); await button(unknownWorkspace.dialog, '继续逐项核查当前草稿').onclick();
  const imported = unknownWorkspace.calls.find(call => call.url.endsWith('/fork'));
  assert.equal(imported.body.fromHistory, true); assert.equal(imported.body.sessionId, 'new-target-session'); assert.equal(imported.body.workspaceId, unknownWorkspace.manager.active().id);
  assert.equal(unknownWorkspace.reviewOpens[0].literatureConfig.query, 'LATEST PREPARED DRAFT'); assert.equal(unknownWorkspace.saved.literatureRevisionOriginal.job.id, job.id);
  console.log('LITERATURE_HISTORY_DETAILS_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
