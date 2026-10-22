'use strict';

// Render the production settings panel with a small DOM/storage fixture. This
// test does not open a browser, contact a server, or change any real task files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
const storageKey = 'research_codex_tasks_v1';
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'Missing production function: ' + name);
  return source.slice(start, end + 4);
}

class Element {
  constructor(tag, text, className) {
    this.tag = tag; this.textContent = text || ''; this.className = className || '';
    this.children = []; this.parentElement = null; this.open = false;
  }
  get isConnected() { return this.tag === 'body' || !!this.parentElement?.isConnected; }
  append(...items) {
    for (const item of items) {
      this.children.push(item);
      if (item && typeof item === 'object') item.parentElement = this;
    }
  }
  prepend(...items) { this.children.unshift(...items); for (const item of items) item.parentElement = this; }
  replaceChildren(...items) {
    for (const item of this.children) if (item && typeof item === 'object') item.parentElement = null;
    this.children.length = 0; this.append(...items);
  }
  setAttribute(key, value) { this[key] = value; }
}
const elements = element => [element, ...(element.children || []).filter(child => child && typeof child === 'object').flatMap(elements)];

function createHarness(storage) {
  const calls = [], writes = [], body = new Element('body');
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { writes.push({ key, value }); storage.set(key, String(value)); }
  };
  const node = (tag, text, className) => new Element(tag, text, className);
  const context = vm.createContext({
    localStorage, preferences: {}, node, panel: body,
    root: { LiteratureUI: { isBusy: () => false } },
    document: { dispatchEvent() {} }, CustomEvent: class {},
    LITERATURE_UNTIL_OPTIONS: [['discover', '仅检索候选'], ['fulltext', '获取全文']],
    LITERATURE_STAGE_ORDER: ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'],
    LITERATURE_SOURCE_LABELS: { pubmed: 'PubMed', cnki: '中国知网' },
    LITERATURE_EXECUTABLE_SOURCES: ['pubmed', 'cnki'],
    newLiteratureSourceOrder: values => [...(values || [])],
    sameLiteratureConfig: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameLiteratureDeferralConfig: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    literatureSource: () => 'fixture-source', literatureStageLabel: stage => stage,
    literatureAttentionMessage: job => job.message || 'paused',
    literatureProcessingBasisMessage: () => '', literatureStageBar: () => null,
    literatureDeliverables: () => null, literatureHistory: () => node('details', undefined, 'fixture-history'),
    render: () => { calls.push({ action: 'render' }); },
    request: (...args) => { calls.push({ action: 'request', args }); throw new Error('Settings disclosure must not make a request'); }
  });
  const start = source.indexOf('  const tasks = {};');
  const end = source.indexOf('  const literatureFieldDraftKey');
  assert.ok(start >= 0 && end > start, 'Missing production task storage initialization');
  vm.runInContext(source.slice(start, end) + '\n' + ['task', 'persist', 'literaturePanel'].map(functionSource).join('\n')
    + '\nglobalThis.subject = {task, literaturePanel, getSaved: () => saved};', context);
  const subject = context.subject;
  return {
    subject, calls, writes, storage, body,
    render(id = 'module-a') {
      body.replaceChildren();
      subject.literaturePanel({ id }, subject.task(id), body);
      const details = elements(body).find(item => item.className === 'literature-config');
      assert.ok(details, 'Production panel exposes the settings disclosure');
      return details;
    }
  };
}

function makeConfig() {
  return { topic: '肉鸡高温小样', query: 'broiler heat stress', sources: ['pubmed'], searchMode: 'test',
    inclusion: ['原始研究'], exclusion: ['蛋鸡'], targetFields: ['温度'], studyTypes: [] };
}
function setJob(task, status) {
  task.literatureJob = { id: 'fixture-job', status, stage: status === 'needs_attention' ? 'verification' : 'discover',
    resumeStage: 'fulltext', config: plain(task.literatureConfig), count: 50, message: 'fixture paused', events: [], files: [] };
}
function summary(details) { return details.children.find(item => item.tag === 'summary'); }
function nativeClick(details) {
  summary(details).onclick({ defaultPrevented: false });
  details.open = !details.open; // Native default action; toggle is dispatched later.
}
function checkLocalOnly(harness, configBefore, jobBefore, id = 'module-a') {
  assert.equal(JSON.stringify(harness.subject.task(id).literatureConfig), configBefore, 'Disclosure cannot edit scientific configuration');
  assert.equal(JSON.stringify(harness.subject.task(id).literatureJob), jobBefore, 'Disclosure cannot mutate the paused task');
  assert.equal(harness.calls.length, 0, 'Disclosure must neither render recursively nor request execution');
}

const storage = new Map([[storageKey, JSON.stringify({
  'module-a': { literatureConfig: makeConfig(), literatureSource: 'fixture-source', preserved: 'keep-me' },
  'module-b': { literatureConfig: makeConfig(), literatureSource: 'fixture-source' }
})]]);
const harness = createHarness(storage);
const task = harness.subject.task('module-a');
assert.equal(task.literatureConfigOpen, null, 'No saved preference retains the context-dependent default');
let details = harness.render();
assert.equal(details.open, true, 'A new configuration initially opens');
details.ontoggle();
assert.equal(task.literatureConfigOpen, null, 'Programmatic initialization is not a user choice');
assert.equal(harness.writes.length, 0);

setJob(task, 'needs_attention');
details = harness.render();
assert.equal(details.open, false, 'Legacy attention default remains collapsed before a user choice');
details.ontoggle();
assert.equal(task.literatureConfigOpen, null, 'Collapsed initialization must not pin the legacy default');
setJob(task, 'running');
details = harness.render();
assert.equal(details.open, true, 'Unchosen state can follow the existing context default');

// Capture the click synchronously; a polling render may precede native toggle.
const configBefore = JSON.stringify(task.literatureConfig), jobBefore = JSON.stringify(task.literatureJob);
const oldDetails = details;
nativeClick(oldDetails);
assert.equal(task.literatureConfigOpen, false, 'Summary click saves collapse before asynchronous toggle');
assert.equal(harness.subject.getSaved()['module-a'].literatureConfigOpen, false);
details = harness.render();
assert.equal(oldDetails.isConnected, false);
assert.equal(details.open, false, 'Polling render must not reopen the settings');
oldDetails.open = true; oldDetails.ontoggle();
assert.equal(task.literatureConfigOpen, false, 'A queued event from a detached old panel cannot overwrite collapse');
assert.equal(harness.render().open, false, 'Repeated redraw keeps collapse');

details = harness.render();
nativeClick(details); details.ontoggle();
assert.equal(task.literatureConfigOpen, true, 'The same summary can expand again');
assert.equal(harness.render().open, true, 'Expand also survives redraw');
assert.equal(harness.subject.getSaved()['module-a'].preserved, 'keep-me', 'Saving disclosure preserves unrelated saved fields');
checkLocalOnly(harness, configBefore, jobBefore);

// A native toggle without the explicit click handler is still persisted.
details = harness.render(); details.open = false; details.ontoggle();
assert.equal(task.literatureConfigOpen, false);
const refreshed = createHarness(storage);
assert.equal(refreshed.subject.task('module-a').literatureConfigOpen, false, 'Refresh reconstructs the saved collapse');
assert.equal(refreshed.render().open, false);
const other = refreshed.subject.task('module-b');
assert.equal(other.literatureConfigOpen, null, 'One module cannot impose its preference on another');
let otherDetails = refreshed.render('module-b');
assert.equal(otherDetails.open, true);
nativeClick(otherDetails); otherDetails.ontoggle();
details = refreshed.render('module-a'); nativeClick(details); details.ontoggle();
assert.equal(refreshed.render().open, true);
assert.equal(refreshed.render('module-b').open, false, 'Module B keeps its own collapsed state');

// A prevented summary action cannot be mistaken for a user expansion.
otherDetails = refreshed.render('module-b');
summary(otherDetails).onclick({ defaultPrevented: true });
assert.equal(other.literatureConfigOpen, false);
assert.equal(refreshed.calls.length, 0);
const persisted = JSON.parse(storage.get(storageKey));
assert.deepEqual(persisted['module-a'].literatureConfig, makeConfig());
assert.deepEqual(persisted['module-b'].literatureConfig, makeConfig());
assert.equal(persisted['module-a'].literatureConfigOpen, true);
assert.equal(persisted['module-b'].literatureConfigOpen, false);
console.log('LITERATURE_CONFIG_TOGGLE_TESTS_PASS');
