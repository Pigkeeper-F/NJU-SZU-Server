#!/usr/bin/env node
'use strict';
// Production entry, production review DOM and production server/store routes.
// Only temporary fixture files and memory storage are used. No model or search.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { LiteratureRuleReviewStore, MAX_REVIEW_BODY_BYTES, MAX_REVIEW_CONTEXT_BYTES } = require('./literature-rule-review');
const { normalizeConfig, MAX_QUERY_CHARS } = require('./literature-config');
const { buildLiteraturePrepare, PREPARE_INSTRUCTIONS } = require('./literature-prepare');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const all = el => [el, ...(el.children || []).flatMap(all)];
const text = el => all(el).map(node => node.textContent || '').join('\n');
class Element {
  constructor(tag) { Object.assign(this, { tag, tagName: tag.toUpperCase(), children: [], textContent: '', value: '', listeners: {} }); }
  append(...items) { items.forEach(item => { item.parent = this; this.children.push(item); }); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelectorAll(selector) { return all(this).filter(item => selector.split(/,\s*/).includes(item.tag)); }
}
function codexFunction(name) {
  const source = read('js/codex.js'), prefix = source.includes('  async function ' + name + '(') ? '  async function ' : '  function ';
  const start = source.indexOf(prefix + name + '('); assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function codexDraftEntry() {
  const lines = read('js/codex.js').split(/\r?\n/);
  const anchors = lines.flatMap((line, index) => line.includes("'literature-confirm literature-frozen-review'") ? [index] : []);
  assert.equal(anchors.length, 1, 'The production frozen-review section has one entry');
  const anchor = anchors[0], sectionIndent = lines[anchor].match(/^[ \t]*/)[0].length;
  let start = anchor - 1;
  while (start >= 0 && !(/^([ \t]*)if\s*\(/.test(lines[start]) && lines[start].match(/^[ \t]*/)[0].length < sectionIndent)) start--;
  assert.ok(start >= 0, 'The production entry retains its enclosing visibility guard');
  const indent = lines[start].match(/^[ \t]*/)[0];
  const stop = lines.findIndex((line, index) => index > anchor && line.trimEnd() === indent + '}');
  assert.ok(stop > anchor, 'The complete production entry block is available');
  return lines.slice(start, stop + 1).join('\n');
}
async function main() {
  const temp = await fsp.mkdtemp(path.join(path.resolve(__dirname, '..'), '.test-current-draft-card-'));
  try {
    const store = new LiteratureRuleReviewStore(temp), sessionId = crypto.randomUUID(), jobId = crypto.randomUUID(), moduleId = 'draft-card-fixture';
    const OLD = 'OLD FROZEN SCIENTIFIC QUERY';
    const NEW = '(broiler OR swine OR bovine) AND (' + Array.from({ length: 160 }, (_, i) => 'ambient_temperature_' + i).join(' OR ') + ')';
    assert.ok(NEW.length > 2000 && NEW.length < MAX_QUERY_CHARS);
    const frozenConfig = normalizeConfig({ topic: 'Archived run', query: OLD, sources: ['scopus'], sourceQueries: { scopus: OLD }, searchMode: 'formal', stopMode: 'end' });
    const job = { id: jobId, status: 'cancelled', until: 'discover', config: frozenConfig }, originalJob = JSON.stringify(job);
    const initialConfig = normalizeConfig({ ...clone(frozenConfig), query: NEW, sourceQueries: { scopus: NEW } });
    const longText = 'Complete original discussion: ' + 'context '.repeat(26000) + 'END_OF_FULL_CONTEXT';
    assert.ok(Buffer.byteLength(longText) > 160 * 1024);
    const mod = { id: moduleId, type: 'literature-mining', messages: [{ id: 'original-message', role: 'user', at: '2026-10-27T00:00:00Z', text: longText }] };
    const sourceSignature = JSON.stringify({ messages: mod.messages.map(m => [m.id, m.at]), approvedDoc: null });
    const calls = [], bodyLimits = [];
    const server = read('server.js'), begin = server.indexOf('async function handleLiterature('), end = server.indexOf('\nfunction normalizeMessages(', begin);
    const routes = vm.createContext({ JSON, MAX_REVIEW_BODY_BYTES, literatureRuleReviews: store,
      codex: { session: id => assert.equal(id, sessionId) },
      readBody: async (req, limit) => { bodyLimits.push(limit); if (Buffer.byteLength(req.body) > limit) throw new Error('请求内容过大，原内容未截断'); return req.body; },
      sendJson: (res, status, data) => Object.assign(res, { status, data }) });
    vm.runInContext(server.slice(begin, end), routes);
    async function request(url, options = {}) {
      const data = options.body ? JSON.parse(options.body) : null; calls.push({ url, method: options.method || 'GET', data });
      const response = {}; await routes.handleLiterature({ method: options.method || 'GET', body: options.body || '{}' }, response, new URL('http://fixture' + url));
      if (response.status >= 400) throw Object.assign(new Error(response.data.error), { status: response.status });
      if (response.data.items && (url.endsWith('/create') || url.endsWith('/action'))) {
        // Test descriptions prevent automatic explanatory model calls.
        response.data.items.forEach(item => { if (!item.annotation.explanation) item.annotation.explanation = 'Offline fixture explanation'; });
        await store._write(response.data);
      }
      return clone(response.data);
    }
    function boot(savedClient) {
      const client = clone(savedClient || { sessionId, literatureJobId: jobId, literatureConfig: initialConfig,
        literatureUntil: 'discover', literatureReviewNeedsSync: true, literatureSource: sourceSignature });
      const current = { literatureJob: clone(job), literatureConfig: clone(client.literatureConfig), literatureUntil: client.literatureUntil,
        literatureRuleReview: clone(client.literatureRuleReview), literatureReviewNeedsSync: client.literatureReviewNeedsSync === true };
      const body = new Element('body'), storage = new Map();
      storage.set('client', JSON.stringify({ [moduleId]: client }));
      const root = { TaskManager: { currentTaskId: () => 'fixture-project' }, ModuleSpace: { isBusy: () => false } };
      const context = vm.createContext({ root, window: root, document: { body, createElement: tag => new Element(tag) }, account: null,
        key: 'client', saved: { [moduleId]: client }, task: () => current, Store: { getState: () => ({ activeModuleId: moduleId, modules: [clone(mod)] }) },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        literatureWorkspaceManager: () => ({ active: () => ({ id: 'fixture-workspace' }), saveActive: () => ({ ok: true }) }),
        effectiveLiteratureReviewConfig: t => clone(t.literatureConfig), literatureSource: () => sourceSignature,
        LITERATURE_SOURCE_LABELS: { scopus: 'Scopus' }, render() {}, persist() { storage.set('client', JSON.stringify(context.saved)); },
        node: (tag, value, cls) => { const el = new Element(tag); el.textContent = value || ''; el.className = cls || ''; return el; },
        request, session: async () => sessionId, setTimeout, Promise });
      vm.runInContext(read('js/literature-rule-review.js'), context);
      vm.runInContext(codexFunction('commitLiteratureRevision') + '\n' + codexFunction('openLiteratureRuleReview') + '\nglobalThis.realOpen=openLiteratureRuleReview;', context);
      // Locate by the rendered section, preserving the real visibility guard and onclick.
      vm.runInContext('globalThis.actualEntry=function(mod,t,box){const segment=null,readOnlyResults=false,job=t.literatureJob;\n' + codexDraftEntry() + '\n};', context);
      return { context, current, body, storage, get client() { return clone(context.saved[moduleId]); },
        async clickDraft() { const entry = new Element('div'); context.actualEntry(clone(mod), current, entry);
          const button = all(entry).find(el => el.tag === 'button' && el.textContent === '继续逐项核查');
          assert.ok(button && !button.disabled, 'The real old-job workbench exposes a usable current-draft button'); await button.onclick(); }
      };
    }
    const h = boot();
    const confirmedPlanEntry = new Element('div'), confirmedPlanTask = clone(h.current);
    confirmedPlanTask.literatureJob.config.researchPlan = { id: 'confirmed-plan-fixture' };
    h.context.actualEntry(clone(mod), confirmedPlanTask, confirmedPlanEntry);
    assert.equal(confirmedPlanEntry.children.length, 0, 'Confirmed research plans do not expose the generic draft entry');
    await h.clickDraft();
    assert.equal(h.current.literatureError, undefined);
    assert.ok(calls.some(call => call.url.endsWith('/create')), 'Current draft creates a separate review without forking the old snapshot');
    assert.equal(h.current.literatureJob.id, jobId); assert.equal(JSON.stringify(job), originalJob);
    const tab = all(h.body).find(el => el.tag === 'button' && el.textContent.startsWith('2. ')); assert.ok(tab); await tab.onclick();
    assert.ok(text(h.body).includes(NEW), 'Actual editable review card contains the full new source-specific expression');
    const defaultCard = all(h.body).find(el => el.tag === 'section' && el.children.some(child => child.tag === 'div' && text(child).includes('默认检索式')));
    assert.ok(defaultCard && text(defaultCard).includes(NEW), 'Actual default-query card also shows the complete new expression');
    assert.ok(!text(h.body).includes(OLD));
    const card = all(h.body).find(el => el.tag === 'section' && el.children.some(child => child.tag === 'div' && text(child).includes('各来源检索式')));
    assert.ok(card); all(card).find(el => el.tag === 'button' && el.textContent === '修改').onclick();
    const field = all(h.body).find(el => el['aria-label'] === '修改各来源检索式'); assert.ok(field);
    const REVISED = NEW + ' AND external_environment'; field.value = JSON.stringify({ scopus: REVISED });
    await all(h.body).find(el => el.tag === 'form').onsubmit({ preventDefault() {} });
    assert.ok(text(h.body).includes(REVISED));
    assert.equal(h.client.literatureJobId, jobId); assert.equal(h.client.literatureDraftReviewForJobId, jobId);
    assert.equal(h.client.literatureConfig.sourceQueries.scopus, REVISED);
    assert.equal(h.current.literatureRuleReview.items.find(item => item.id === 'source-queries').status, 'pending');
    const saved = JSON.parse(h.storage.get('client'))[moduleId]; h.context.root.LiteratureRuleReview.close();
    const refreshed = boot(saved); await refreshed.clickDraft();
    const secondTab = all(refreshed.body).find(el => el.tag === 'button' && el.textContent.startsWith('2. ')); await secondTab.onclick();
    assert.ok(text(refreshed.body).includes(REVISED), 'Reloaded actual card uses saved draft, not old frozen expression');
    const restartedStore = new LiteratureRuleReviewStore(temp);
    const stored = await restartedStore.get(refreshed.client.literatureDraftReviewId, sessionId);
    assert.equal(stored.context.messages[0].text, longText); assert.equal(stored.config.sourceQueries.scopus, REVISED);
    assert.equal(stored.config.query, NEW);
    assert.equal(stored.ready, false); assert.equal(refreshed.client.literatureReviewAppliedRevision, undefined);
    assert.ok(bodyLimits.every(limit => limit === MAX_REVIEW_BODY_BYTES));
    assert.ok(calls.every(call => !/\/search|\/advance|\/fork|\/assist/.test(call.url)), 'Reviewing a current draft never starts/forks/resumes a search or invokes a model');

    const boundary = 'q'.repeat(MAX_QUERY_CHARS);
    const bounded = normalizeConfig({ ...clone(frozenConfig), query: boundary, sourceQueries: { scopus: boundary } });
    assert.equal(bounded.query, boundary); assert.equal(bounded.sourceQueries.scopus, boundary);
    for (const extra of [{ query: boundary + 'x' }, { sourceQueries: { scopus: boundary + 'x' } }]) {
      assert.throws(() => normalizeConfig({ ...clone(frozenConfig), ...extra }), /32768.*未自动截断/);
    }
    assert.ok(PREPARE_INSTRUCTIONS.includes(String(MAX_QUERY_CHARS)));
    const prepared = buildLiteraturePrepare({ messages: [{ role: 'user', text: longText }], currentConfig: bounded, until: 'discover' });
    assert.equal(JSON.parse(prepared.messages[0].content).currentConfig.sourceQueries.scopus, boundary);
    const largeRequest = { sessionId, workspaceId: 'fixture-workspace', config: { ...clone(bounded),
      inclusion: Array.from({ length: 200 }, (_, index) => 'Fixture rule ' + index + ': ' + 'r'.repeat(1850)) }, until: 'discover', source: sourceSignature,
      context: { messages: Array.from({ length: 4 }, (_, index) => ({ role: 'user', text: 'x'.repeat(450000) + 'TAIL_' + index })), approvedDoc: '' } };
    assert.ok(Buffer.byteLength(JSON.stringify(largeRequest)) > 2 * 1024 * 1024, 'Combined valid context and config exceed the former generic body limit');
    const largeReview = await request('/api/literature/rule-review/create', { method: 'POST', body: JSON.stringify(largeRequest) });
    assert.equal(largeReview.context.messages.at(-1).text, largeRequest.context.messages.at(-1).text);
    const reviewFile = path.join(temp, '.workbench', 'literature-rule-reviews', stored.id, 'review.json'), before = await fsp.readFile(reviewFile, 'utf8');
    await assert.rejects(store.act({ id: stored.id, sessionId, revision: stored.revision, action: 'sync', config: stored.config,
      until: stored.until, source: sourceSignature, context: { messages: [{ role: 'user', text: 'x'.repeat(MAX_REVIEW_CONTEXT_BYTES + 1) }], approvedDoc: '' } }), /2MiB.*未截断/);
    assert.equal(await fsp.readFile(reviewFile, 'utf8'), before, 'Oversized context is rejected without losing prior review');
    await assert.rejects(request('/api/literature/rule-review/create', { method: 'POST', body: JSON.stringify({ ...largeRequest,
      context: { messages: [{ role: 'user', text: 'x'.repeat(MAX_REVIEW_BODY_BYTES) }], approvedDoc: '' } }) }), /过大.*未截断/);
    for (let groupIndex = 1; groupIndex <= 4; groupIndex++) {
      const groupTab = all(refreshed.body).find(el => el.tag === 'button' && el.textContent.startsWith(groupIndex + '. ')); await groupTab.onclick();
      const confirm = all(refreshed.body).find(el => el.tag === 'button' && el.textContent === '确认当前组'); await confirm.onclick();
    }
    const apply = all(refreshed.body).find(el => el.tag === 'button' && el.textContent === '使用已确认配置'); assert.equal(apply.disabled, false); apply.onclick();
    assert.equal(refreshed.current.literatureJob, null); assert.equal(refreshed.client.literatureJobId, undefined);
    assert.equal(refreshed.client.literatureRevisionOriginal.job.id, jobId); assert.equal(JSON.stringify(job), originalJob);
    assert.equal(refreshed.client.literatureReviewAppliedRevision, refreshed.current.literatureRuleReview.revision);
    const permitted = await restartedStore.execution({ id: refreshed.client.literatureRuleReviewId, sessionId, workspaceId: 'fixture-workspace',
      revision: refreshed.client.literatureReviewAppliedRevision, config: refreshed.client.literatureConfig, until: refreshed.client.literatureUntil });
    assert.equal(permitted.config.sourceQueries.scopus, REVISED, 'After explicit confirmations/apply the server execution gate accepts the new draft');
    assert.ok(calls.every(call => !/\/search|\/advance|\/fork|\/assist/.test(call.url)), 'Even applying the draft does not execute a search');
    console.log('LITERATURE_CURRENT_DRAFT_CARD_TESTS_PASS');
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
