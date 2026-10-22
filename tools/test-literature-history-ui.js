'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function functionSource(name) {
  const prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '('); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
class Element {
  constructor(tag, text, cls) { this.tag = tag; this.textContent = text || ''; this.className = cls || ''; this.children = []; }
  append(...items) { this.children.push(...items); }
  setAttribute(key, value) { this[key] = value; }
}
const elements = parent => [parent, ...parent.children.flatMap(elements)];
const buttons = parent => elements(parent).filter(item => item.tag === 'button');
const mod = { id: 'module-a', messages: [{ role: 'user', text: 'preserve discussion' }] };
const active = { id: 'job-a', status: 'needs_attention', stage: 'verification', resumeStage: 'discover', until: 'discover',
  config: { topic: 'fixture', query: 'frozen query', sources: ['cnki'] }, count: 30, files: ['candidates.csv'], events: [], deletedAt: null };
const running = { ...copy(active), id: 'job-b', status: 'running' };
const removed = { ...copy(active), id: 'job-c', deletedAt: '2026-10-20T00:00:00.000Z' };
const tasks = {
  'module-a': { literatureJob: copy(active), literatureConfig: { query: 'editable scientific rules', targetFields: ['温度'] }, literatureUntil: 'discover',
    literatureJobs: [copy(active), copy(running)], literatureJobsTried: true, literatureJobsLoading: false, literatureHistoryBusy: null,
    literatureBusy: false, busy: false, literatureIncludeDeleted: false },
  'module-b': { literatureJob: copy(running), literatureConfig: copy(running.config) }
};
const saved = { 'module-a': { literatureJobId: active.id, literatureConfig: copy(tasks['module-a'].literatureConfig), literatureDelivered: 'stamp' },
  'module-b': { literatureJobId: running.id } };
let history = [copy(active), copy(running), copy(removed)], failDelete = false, pendingRead = null;
const calls = [], messages = [];
const context = vm.createContext({
  task: id => tasks[id], saved, root: { LiteratureUI: { isBusy: () => false } }, node: (tag, text, cls) => new Element(tag, text, cls),
  render() {}, persist() {}, closeLiteratureFields() {}, literatureSource: () => 'fixture-source', literatureStageLabel: stage => stage,
  LITERATURE_STATUS_LABELS: { needs_attention: '需要人工', running: '进行中', completed: '已完成' },
  literatureCompletedMessage: () => 'completed', literatureAttentionMessage: job => job.message || 'paused', autoOpenLiteratureBrowser: async () => false,
  Store: { appendMessage: (...args) => messages.push(args) }, setTimeout: callback => { callback(); return 1; },
  request: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body });
    if (url.startsWith('/api/literature/jobs?')) return { jobs: copy(history.filter(job => url.includes('includeDeleted=1') || !job.deletedAt)) };
    if (url.startsWith('/api/literature/job?')) {
      if (pendingRead) return pendingRead;
      return copy(history.find(job => job.id === new URL(url, 'http://localhost').searchParams.get('id')));
    }
    if (url === '/api/literature/delete' || url === '/api/literature/restore') {
      if (failDelete) throw new Error('fixture mutation failed');
      history = history.map(job => job.id === body.id ? { ...job, deletedAt: url.endsWith('/delete') ? '2026-10-20T01:00:00.000Z' : null } : job);
      return copy(history.find(job => job.id === body.id));
    }
    throw new Error('Unexpected request: ' + url);
  }
});
const FUNCTIONS = ['detachLiteratureJob', 'changeLiteratureHistory', 'loadLiteratureJobs', 'attachLiteratureJob', 'literatureHistory', 'watchLiterature', 'applyLiteratureJob'];
vm.runInContext(FUNCTIONS.map(functionSource).join('\n') + '\nglobalThis.subject = { ' + FUNCTIONS.join(', ') + ' };', context);
const subject = context.subject, current = tasks['module-a'];

async function main() {
  let panel = subject.literatureHistory(mod, current);
  const rows = elements(panel).filter(item => item.className.startsWith('literature-history-row'));
  assert.equal(buttons(rows[0]).find(button => button.textContent === '删除').disabled, false);
  assert.equal(buttons(rows[1]).find(button => button.textContent === '删除').disabled, true, 'Running history cannot be deleted');
  await buttons(panel).find(button => button.textContent === '查看已删除').onclick();
  assert.ok(calls.at(-1).url.endsWith('&includeDeleted=1'));
  panel = subject.literatureHistory(mod, current);
  const deletedRow = elements(panel).find(item => item.className.startsWith('literature-history-row') && elements(item).some(child => child.textContent === '已删除，可恢复'));
  assert.deepEqual(buttons(deletedRow).map(button => button.textContent), ['恢复'], 'Deleted rows expose only Restore');
  const rulesBytes = JSON.stringify(current.literatureConfig), otherTaskBytes = JSON.stringify(tasks['module-b']), chatBytes = JSON.stringify(mod.messages);
  const bindingGeneration = current.literatureWatchGeneration || 0;
  await subject.changeLiteratureHistory(mod, active);
  assert.deepEqual(calls.find(call => call.url === '/api/literature/delete').body, { id: active.id });
  assert.equal(current.literatureJob, null); assert.equal(saved['module-a'].literatureJobId, undefined);
  assert.ok(current.literatureWatchGeneration > bindingGeneration, 'Deleting a bound job invalidates its poll generation');
  assert.equal(JSON.stringify(current.literatureConfig), rulesBytes, 'Scientific draft stays available');
  assert.equal(JSON.stringify(tasks['module-b']), otherTaskBytes, 'Deleting one job cannot unbind another module');
  assert.equal(JSON.stringify(mod.messages), chatBytes); assert.equal(messages.length, 0, 'Delete must preserve the discussion');
  await subject.changeLiteratureHistory(mod, history.find(job => job.id === active.id), true);
  assert.equal(current.literatureJob, null, 'Restore does not execute or automatically bind a task');
  const restored = history.find(job => job.id === active.id);
  assert.equal(restored.count, 30); assert.deepEqual(restored.files, active.files); assert.equal(restored.status, active.status);
  subject.attachLiteratureJob(mod, restored); assert.equal(current.literatureJob.id, active.id);
  const beforeRunning = calls.length; await subject.changeLiteratureHistory(mod, running);
  assert.equal(calls.length, beforeRunning, 'Guard rejects direct running deletion too');
  assert.match(current.literatureJobsError, /先停止/);
  failDelete = true; await subject.changeLiteratureHistory(mod, restored);
  assert.equal(current.literatureJob.id, active.id, 'Rejected deletion keeps the current binding');
  assert.match(current.literatureJobsError, /删除失败/); failDelete = false;

  // A response that was already in flight cannot reattach the deleted job.
  let releaseRead;
  pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const polling = subject.watchLiterature(mod.id, active.id);
  subject.detachLiteratureJob(mod.id, active.id);
  releaseRead(copy(active)); await polling; pendingRead = null;
  assert.equal(current.literatureJob, null); assert.equal(current.literatureBusy, false);
  assert.equal(saved[mod.id].literatureJobId, undefined);
  subject.attachLiteratureJob(mod, removed);
  assert.equal(current.literatureJob, null, 'A deleted row cannot be loaded before restore');
  subject.attachLiteratureJob(mod, restored);
  history = history.map(job => job.id === active.id ? { ...job, deletedAt: '2026-10-20T02:00:00.000Z' } : job);
  await subject.watchLiterature(mod.id, active.id);
  assert.equal(current.literatureJob, null, 'A deletion received by polling also clears the local binding');
  assert.ok(!calls.some(call => ['/api/literature/search', '/api/literature/advance', '/api/literature/browser'].includes(call.url)));
  console.log('LITERATURE_HISTORY_UI_TESTS_PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
