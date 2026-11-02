#!/usr/bin/env node
'use strict';
// Offline DOM/event fixture with real EventTarget, Store and workspace manager.
// It models document→window bubbling; no user browser, service or model runs.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
class CustomEvent extends Event { constructor(type, options = {}) { super(type, options); this.detail = options.detail; } }
class Element {
  constructor(tag, text = '') { this.tagName = tag.toUpperCase(); this.textContent = text; this.children = []; this.attributes = {}; }
  append(...items) { items.forEach(item => { item.parentNode = this; this.children.push(item); }); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.onclose?.(); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); }
  click() { return this.onclick?.(); }
  scrollIntoView(options) { this.scrollOptions = options; let parent = this.parentNode; while (parent && parent.tagName !== 'DIALOG') parent = parent.parentNode; if (parent) { parent.lastScrollTarget = this; parent.scrollTop = 0; } }
  focus(options) { this.focusOptions = options; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
}
const all = node => [node, ...node.children.flatMap(all)], text = node => all(node).map(item => item.textContent).join('\n');
const button = (node, label) => all(node).find(item => item.tagName === 'BUTTON' && item.textContent === label);
function harness(options = {}) {
  let project = 'project-a', seq = 0, denyStorage = false, failNetwork = false, renderCount = 0, client = { literatureConfig: { topic: 'Discussion A', query: 'draft query' }, literatureUntil: 'discover' };
  let chat = { composer: '', draftText: '', editing: false }, rules = { draft: 'Rules draft', confirmed: '', versions: [] };
  const storage = new Map(), timers = new Map(), calls = [], archives = new Map(), detailReads = new Map(), recoveries = new Map(); let timerId = 0;
  const root = new EventTarget(); Object.assign(root, { CustomEvent, crypto: { randomUUID: () => String(++seq) },
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] || null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (denyStorage && key === 'research_literature_workspaces_v1') throw new Error('fixture quota'); storage.set(key, String(value)); }, removeItem: key => storage.delete(key) } });
  class Document extends EventTarget {
    constructor() { super(); this.body = new Element('body'); }
    createElement(tag) { const item = new Element(tag); item.ownerDocument = this; return item; }
    querySelectorAll(selector) { return all(this.body).filter(item => item.getAttribute('data-literature-discussion-scope') !== undefined); }
    dispatchEvent(event) {
      super.dispatchEvent(event);
      if (event.bubbles) { const forwarded = new CustomEvent(event.type, { bubbles: true, cancelable: event.cancelable, detail: event.detail }); root.dispatchEvent(forwarded); if (forwarded.defaultPrevented) event.preventDefault(); }
      return !event.defaultPrevented;
    }
  }
  const document = new Document(); root.document = document;
  vm.runInNewContext(read('store.js'), { window: root });
  const mod = root.Store.addModule('文献挖掘'); root.Store.selectModule(mod.id);
  root.Store.appendMessage(mod.id, 'A original user discussion', 'user'); root.Store.appendMessage(mod.id, 'A original AI discussion', 'assistant');
  root.TaskManager = { currentTaskId: () => project, snapshotModuleRules: () => clone(rules), restoreModuleRules: (id, value) => { rules = clone(value); return true; } };
  root.ModuleSpace = { isBusy: () => false, snapshotContext: () => clone(chat), resetContext: (id, value) => { chat = clone(value || { composer: '', draftText: '', editing: false }); return true; }, render() {} };
  root.LiteratureUI = { isBusy: () => false, snapshotContext: () => null, restoreContext: () => true };
  vm.runInNewContext(read('literature-task-workspaces.js'), { window: root });
  const manager = root.LiteratureTaskWorkspaces.createManager({ moduleId: mod.id, adapter: {
    snapshotClient: () => clone(client), applyClient: value => { client = clone(value); return true; }, isBusy: () => false
  } }); manager.ensure(); manager.saveActive();
  root.CodexUI = { literatureWorkspace: () => manager, render: () => { renderCount++; }, busy: () => false, renderLiteratureWorkspace() {} };
  const response = data => ({ ok: true, json: async () => clone(data) });
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, method: options.method || 'GET', body });
    if (failNetwork) throw new Error('fixture offline'); const parsed = new URL(url, 'http://fixture.invalid');
    if (parsed.pathname === '/api/literature/discussions' && body) {
      const key = [body.projectId, body.moduleId, body.workspaceId].join(':'); const versions = archives.get(key) || [];
      if (versions.length && JSON.stringify(versions.at(-1).snapshot) === JSON.stringify(body.snapshot)) return response({ saved: true, deduplicated: true, discussion: versions.at(-1) });
      const record = { ...clone(body), revision: versions.length + 1, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:01:00Z',
        messageCount: body.snapshot.messages.length, hasDraft: !!body.snapshot.composer };
      versions.push(record); archives.set(key, versions); return response({ saved: true, deduplicated: false, discussion: record });
    }
    if (parsed.pathname === '/api/literature/discussions') return response({ discussions: [...archives.values()].filter(versions => versions[0].projectId === parsed.searchParams.get('projectId'))
      .map(versions => ({ ...versions.at(-1), versions })) });
    if (parsed.pathname === '/api/literature/discussion') {
      const versions = archives.get([parsed.searchParams.get('projectId'), parsed.searchParams.get('moduleId'), parsed.searchParams.get('workspaceId')].join(':'));
      const revision = Number(parsed.searchParams.get('revision'));
      return response(detailReads.has(revision) ? await detailReads.get(revision) : versions.find(record => record.revision === revision));
    }
    if (parsed.pathname === '/api/literature/discussion-recovery') return response(parsed.searchParams.has('id') ? recoveries.get(parsed.searchParams.get('id')) : { recoveries: [...recoveries.values()].map(({ fragments, ...meta }) => meta) });
    throw new Error('Unexpected offline URL ' + url);
  };
  const context = vm.createContext({ window: root, document, fetch, URLSearchParams, Blob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id), console });
  options.beforeDiscussion?.({ root, storage, manager, mod, chat });
  vm.runInContext(read('literature-discussions.js'), context);
  const dispatch = (type, detail = { moduleId: mod.id }, cancelable = false, bubbles = true) => document.dispatchEvent(new CustomEvent(type, { detail, bubbles, cancelable }));
  async function flush() { for (let round = 0; timers.size && round < 12; round++) { const batch = [...timers.values()]; timers.clear(); for (const callback of batch) await callback(); for (let i = 0; i < 4; i++) await Promise.resolve(); } }
  return { root, mod, manager, document, storage, calls, archives, recoveries, dispatch, flush, get chat() { return chat; }, get client() { return client; }, get renderCount() { return renderCount; },
    setProject: value => { project = value; }, setStorageFailure: value => { denyStorage = value; }, setNetworkFailure: value => { failNetwork = value; },
    deferDetail: (revision, promise) => detailReads.set(revision, promise) };
}
async function main() {
  assert.match(read('chat.js'), /new EventType\('discussion-draft-change', \{ bubbles: true/);
  assert.match(read('tasks.js'), /bubbles: true, cancelable: type === 'discussion-project-before-switch'/);
  const h = harness(); await h.flush(); const original = h.manager.active().id;
  assert.equal(h.calls.filter(call => call.method === 'POST').at(-1).body.snapshot.messages.length, 2, 'Initial local nonempty discussion is backed up in full');
  const posted = h.calls.length; h.chat.composer = 'A unsent words'; h.dispatch('discussion-draft-change', { moduleId: h.mod.id }, false, false); await h.flush();
  assert.equal(h.calls.length, posted, 'A non-bubbling document event does not reach a window subscriber');
  h.dispatch('discussion-draft-change'); await h.flush();
  assert.equal(h.manager.storedSnapshot().snapshot.chat.composer, 'A unsent words'); assert.equal(h.calls.at(-1).body.snapshot.composer, 'A unsent words');
  assert.equal(h.renderCount, 0, 'Autosave status updates never rebuild the configuration editor or steal focus');
  const stateA = h.root.Store.getState();
  assert.equal(h.dispatch('discussion-project-before-switch', { projectId: 'project-a', targetProjectId: 'project-b' }, true), true);
  h.setProject('project-b'); const blank = clone(stateA); blank.modules[0].messages = []; h.root.Store.restoreState(blank);
  h.dispatch('discussion-project-after-switch', { projectId: 'project-b' }); await h.flush();
  assert.equal(h.chat.composer, '', 'First target workspace must not capture the prior project DOM input');
  assert.ok(h.calls.filter(call => call.body?.projectId === 'project-b').every(call => !call.body.snapshot.composer && call.body.snapshot.messages.length === 0));
  h.dispatch('discussion-project-before-switch', { projectId: 'project-b', targetProjectId: 'project-a' }, true);
  h.setProject('project-a'); h.root.Store.restoreState(stateA); h.dispatch('discussion-project-after-switch', { projectId: 'project-a' }); await h.flush();
  assert.equal(h.chat.composer, 'A unsent words'); assert.equal(h.manager.active().id, original);
  h.dispatch('discussion-project-before-switch', { projectId: 'project-a', targetProjectId: 'failed-switch' }, true);
  h.dispatch('discussion-project-switch-cancelled', { projectId: 'project-a' });
  h.chat.composer = 'A edited after cancelled switch'; h.dispatch('discussion-draft-change'); await h.flush();
  assert.equal(h.manager.storedSnapshot().snapshot.chat.composer, 'A edited after cancelled switch', 'A failed project transition must unlock autosave without clearing the current input');
  h.chat.composer = 'A unsent words'; h.dispatch('discussion-draft-change'); await h.flush();
  h.setStorageFailure(true); assert.equal(h.dispatch('discussion-project-before-switch', { projectId: 'project-a', targetProjectId: 'blocked' }, true), false, 'Before-switch storage failure cancels the actual bubbling event');
  assert.equal(h.chat.composer, 'A unsent words'); h.setStorageFailure(false);
  h.setNetworkFailure(true); h.root.LiteratureDiscussions.save(h.mod.id, true); await h.flush(); assert.match(h.root.LiteratureDiscussions.status(h.mod.id).text, /备份失败/);
  assert.equal(h.manager.storedSnapshot().snapshot.chat.composer, 'A unsent words'); h.setNetworkFailure(false); h.root.LiteratureDiscussions.save(h.mod.id, true); await h.flush();
  await h.root.LiteratureDiscussions.open(h.mod.id); const dialog = h.document.body.children.find(item => item.tagName === 'DIALOG');
  button(dialog, '查看讨论').onclick(); assert.match(text(dialog), /A original user discussion/); assert.match(text(dialog), /A original AI discussion/); assert.match(text(dialog), /A unsent words/);
  assert.ok(button(dialog, '下载完整JSON')); assert.ok(button(dialog, '下载讨论全文'));
  const versions = all(dialog).filter(item => item.tagName === 'BUTTON' && item.textContent === '查看此版本');
  let finishOld; h.deferDetail(1, new Promise(resolve => { finishOld = resolve; })); const readingOld = versions.at(-1).onclick(); await versions[0].onclick();
  finishOld(clone([...h.archives.values()][0][0])); await readingOld;
  assert.match(text(dialog), /A unsent words/, 'A slower earlier version cannot replace the most recently selected full discussion');
  button(dialog, '恢复为新的讨论草稿').onclick(); await h.flush();
  assert.notEqual(h.manager.active().id, original); assert.equal(h.root.Store.getState().modules[0].messages.length, 2);
  assert.equal(h.client.sessionId, undefined); assert.equal(h.client.literatureJobId, undefined); assert.equal(h.client.literatureRuleReviewId, undefined);
  assert.ok(h.manager.list().find(entry => entry.id === original).messageCount === 2, 'Restoring makes a new workspace; the source discussion remains');
  assert.ok(h.calls.every(call => /^\/api\/literature\/(?:discussions?|discussion-recovery)(?:\?|$)/.test(call.url)), 'Discussion saving never searches, confirms or calls a model');

  // Real bootstrap loss path: stored active workspace is nonempty while the
  // freshly restored Store is empty. Startup must preserve and archive the old
  // full discussion under a different recovery ID before saving the empty one.
  const empty = harness({ beforeDiscussion({ root, chat }) {
    const state = root.Store.getState(); state.modules[0].messages = []; root.Store.restoreState(state); chat.composer = '';
  } }); await empty.flush();
  assert.equal(empty.root.Store.getState().modules[0].messages.length, 0, 'Finding an old discussion does not silently overwrite the current empty context');
  const emptyFound = empty.root.LiteratureDiscussions.scanBrowser().records;
  const protectedDiscussion = emptyFound.find(record => record.sourceType === 'empty-overwrite-backup');
  assert.equal(protectedDiscussion.snapshot.messages.length, 2);
  assert.ok([...empty.archives.values()].some(versions => versions.some(record => record.snapshot.messages.length === 2)), 'Protected nonempty source reaches the append-only server queue');
  assert.notEqual(protectedDiscussion.workspaceId, empty.manager.active().id, 'Empty current payload cannot debounce away the protected source');

  // Cross-project and legacy-module stores are discoverable even though the
  // current project/module list is empty. Merely scanning never edits old keys.
  const recovered = harness(); await recovered.flush();
  const oldState = recovered.root.Store.getState(); oldState.modules[0].id = 'old-module'; oldState.modules[0].name = '原下载讨论';
  oldState.modules[0].messages[0].text = 'Exact old cross-project discussion';
  const raw = JSON.stringify(oldState), oldKey = 'research_task_state_old-project';
  recovered.storage.set(oldKey, raw);
  recovered.storage.set('fa_projects_v1', JSON.stringify([{ ...oldState, id: 'legacy-project', name: '旧版项目' }]));
  recovered.storage.set('research_task_bootstrap_backups_v1', JSON.stringify({ version: 1, entries: [{ id: 'backup-1', projectId: 'backup-project', reason: 'stale-mirror', savedAt: '2026-10-27T00:00:00Z',
    sources: [{ key: 'fa_state_v1', raw }, { key: 'research_task_state_backup-project', raw: raw.replace('Exact old cross-project discussion', 'Second raw backup original') }] }] }));
  recovered.storage.set('research_task_state_broken', '{broken');
  const priorRegistry = JSON.parse(recovered.storage.get('research_literature_workspaces_v1'));
  const originalBucket = clone(Object.values(priorRegistry.projects)[0]); originalBucket.projectId = 'elsewhere'; originalBucket.moduleId = 'other-lit';
  originalBucket.contexts[0].snapshot.module.id = 'other-lit';
  originalBucket.contexts[0].snapshot.client.literatureRevisionOriginal = { context: { snapshot: clone(originalBucket.contexts[0].snapshot) } };
  priorRegistry.projects['elsewhere:other-lit'] = originalBucket; recovered.storage.set('research_literature_workspaces_v1', JSON.stringify(priorRegistry));
  const oldStorage = new Map(recovered.storage), scan = recovered.root.LiteratureDiscussions.scanBrowser();
  assert.ok(scan.records.some(record => record.projectId === 'old-project' && record.moduleId === 'old-module' && record.snapshot.messages[0].text === 'Exact old cross-project discussion'));
  assert.ok(scan.records.some(record => record.projectId === 'legacy-project'));
  assert.equal(scan.records.filter(record => record.sourceKey.startsWith('research_task_bootstrap_backups_v1:')).length, 2, 'Both exact raw originals in a bootstrap backup are independently recoverable');
  assert.ok(scan.records.some(record => record.snapshot.messages[0].text === 'Second raw backup original'));
  assert.ok(scan.records.some(record => record.sourceType === 'revision-original'));
  assert.ok(scan.errors.some(error => error.includes('research_task_state_broken')));
  assert.deepEqual(recovered.storage, oldStorage, 'Discovery is read-only across all original browser keys');
  await recovered.root.LiteratureDiscussions.open(recovered.mod.id);
  let recoveredDialog = recovered.document.body.children.find(item => item.tagName === 'DIALOG');
  assert.match(text(recoveredDialog), /其他任务与旧版快照/);
  const oldRow = all(recoveredDialog).find(item => item.className === 'literature-discussion-row' && text(item).includes(oldKey));
  button(oldRow, '查看找到的讨论').onclick();
  assert.match(text(recoveredDialog), /Exact old cross-project discussion/);
  button(recoveredDialog, '恢复为新的讨论草稿').onclick(); await recovered.flush();
  assert.equal(recovered.root.Store.getState().modules[0].messages[0].text, 'Exact old cross-project discussion');
  assert.equal(recovered.storage.get(oldKey), raw, 'Explicit new-draft restoration preserves the original project raw state');
  assert.equal(recovered.client.literatureRuleReviewId, undefined);

  // Legacy review recovery is explicitly partial, keeps each source review and
  // overlapping context in its own block, and never imports confirmations.
  recovered.recoveries.set('opaque-review-source', { id: 'opaque-review-source', label: '旧核查片段', messageCount: 2, questionAnswerCount: 1, latestAt: '2026-10-27T00:00:00Z', completeness: 'partial',
    fragments: [
      { kind: 'main-context', messages: [{ id: 'same-original-id', role: 'user', text: 'Recovered main discussion original', at: '2026-10-26T12:00:00Z' }], sources: [{ reviewId: 'review-original', revision: 2, origin: 'sourceHistory' }] },
      { kind: 'main-context', messages: [{ id: 'same-original-id', role: 'user', text: 'Recovered main discussion original' }], sources: [{ reviewId: 'review-later', revision: 3, origin: 'context' }] },
      { kind: 'review-discussion', question: 'Exact card question', answer: 'Exact card explanation', sources: [{ reviewId: 'review-original', revision: 2, itemId: 'sources' }] }
    ] });
  await recovered.root.LiteratureDiscussions.open(recovered.mod.id); await Promise.resolve();
  recoveredDialog = recovered.document.body.children.find(item => item.tagName === 'DIALOG');
  await button(recoveredDialog, '查看核查讨论片段').onclick();
  assert.match(text(recoveredDialog), /非完整主聊天/); assert.match(text(recoveredDialog), /review-original/); assert.match(text(recoveredDialog), /review-later/);
  assert.match(text(recoveredDialog), /Exact card question/); assert.ok(button(recoveredDialog, '下载片段JSON'));
  const callCount = recovered.calls.length; button(recoveredDialog, '将这些片段恢复为新草稿').onclick(); await recovered.flush();
  const fragmentMessages = recovered.root.Store.getState().modules[0].messages;
  assert.equal(fragmentMessages.filter(message => message.text === 'Recovered main discussion original').length, 2, 'Distinct saved contexts remain explicitly separated rather than silently merged');
  assert.equal(new Set(fragmentMessages.map(message => message.id)).size, fragmentMessages.length, 'Overlapping saved context IDs do not prevent the restored draft from being archived');
  assert.ok(fragmentMessages.some(message => message.text.includes('不是完整主聊天')));
  assert.equal(recovered.client.sessionId, undefined); assert.equal(recovered.client.literatureJobId, undefined); assert.equal(recovered.client.literatureRuleReviewId, undefined);
  assert.ok(recovered.calls.slice(callCount).every(call => call.url === '/api/literature/discussions'), 'Explicit fragment restoration only archives a draft, without model/search/confirm/fork');

  // Production click chain in a long, scrollable directory. Previously the
  // preview was appended below every list, so the button appeared to do nothing.
  const long = harness(); await long.flush(); const longState = long.root.Store.getState();
  long.storage.set('fa_projects_v1', JSON.stringify(Array.from({ length: 60 }, (_, index) => {
    const saved = clone(longState); saved.modules[0].messages[0].text = 'Selected source message ' + index;
    return { ...saved, id: 'long-project-' + index, name: 'Saved discussion ' + index };
  })));
  await long.root.LiteratureDiscussions.open(long.mod.id);
  const longDialog = long.document.body.children.find(item => item.tagName === 'DIALOG');
  const lastRow = all(longDialog).find(item => item.className === 'literature-discussion-row' && text(item).includes('Saved discussion 59'));
  const longStorage = new Map(long.storage), requestsBeforePreview = long.calls.length;
  longDialog.scrollTop = 3000; button(lastRow, '查看找到的讨论').click();
  const selectedHeading = all(longDialog).find(item => item.tagName === 'H3' && item.textContent.startsWith('已打开：'));
  const listHeading = all(longDialog).find(item => item.tagName === 'H3' && item.textContent === '当前文献任务的讨论');
  assert.match(selectedHeading.textContent, /Saved discussion 59/);
  assert.ok(all(longDialog).indexOf(selectedHeading) < all(longDialog).indexOf(listHeading), 'Selected content is above all long directories, not hidden below them');
  assert.equal(selectedHeading.getAttribute('tabindex'), '-1'); assert.equal(long.document.activeElement, selectedHeading);
  assert.equal(longDialog.lastScrollTarget, selectedHeading); assert.equal(longDialog.scrollTop, 0);
  assert.match(text(selectedHeading.parentNode), /Selected source message 59/);
  assert.ok(all(longDialog).some(item => item.getAttribute('role') === 'status' && /Saved discussion 59.*2 条消息.*只读预览/.test(item.textContent)));
  assert.deepEqual(long.storage, longStorage); assert.equal(long.calls.length, requestsBeforePreview, 'Clicking a browser source only renders a preview; no storage, restore or execution request');
  button(longDialog, '返回记录列表').click(); assert.equal(long.document.activeElement, listHeading);
  const originalSnapshot = long.manager.snapshot;
  long.manager.snapshot = () => { throw new Error('fixture snapshot unavailable'); };
  button(longDialog, '查看讨论').click();
  let visibleError = all(longDialog).find(item => item.getAttribute('role') === 'alert');
  assert.match(visibleError.textContent, /讨论预览失败.*fixture snapshot unavailable/); assert.equal(long.document.activeElement, visibleError);
  long.manager.snapshot = originalSnapshot;
  long.setProject('another-current-project'); button(lastRow, '查看找到的讨论').click();
  visibleError = all(longDialog).find(item => item.getAttribute('role') === 'alert');
  assert.match(visibleError.textContent, /工作区已切换.*重新|工作区已切换.*再从当前任务打开/);
  assert.equal(long.document.activeElement, visibleError, 'A stale viewer reports the switched context instead of silently ignoring the click');
  button(longDialog, '关闭').click(); assert.deepEqual(long.storage, longStorage);
  console.log('LITERATURE_DISCUSSIONS_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
