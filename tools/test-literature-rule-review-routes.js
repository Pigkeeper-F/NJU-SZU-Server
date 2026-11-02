#!/usr/bin/env node
'use strict';

// Production routes/store/AI parser, temporary files and inert runner only.
// No server socket, Codex process, browser, real research task or search is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { LiteratureRuleReviewStore, MAX_REVIEW_BODY_BYTES } = require('./literature-rule-review');
const { LiteratureRuleReviewAssist } = require('./literature-rule-review-assist');
const { normalizeConfig } = require('./literature-config');
const { LiteratureConnector } = require('./literature-connector');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(root, '.test-literature-review-routes-'));
  try {
    const sessionId = randomUUID(), workspaceId = 'lit-fixture', aiJobs = new Map(), calls = [], knownSessions = new Set([sessionId]);
    const store = new LiteratureRuleReviewStore(temp);
    const codex = {
      session(id) { assert.ok(knownSessions.has(id), 'Target session must exist'); },
      async status() { return { loggedIn: true, model: 'fixture-model' }; },
      async run(sid, messages, instructions, execute, model, type) {
        assert.equal(execute, false); assert.equal(type, 'discussion');
        const prompt = JSON.parse(messages[0].content);
        assert.equal(prompt.originalRules.messages[0].text, '2000年起，中英文；先仅检索候选。');
        assert.match(instructions, /不替用户确认/);
        const job = { id: randomUUID(), sessionId: sid, status: 'completed', text: JSON.stringify({
          annotations: prompt.items.map(item => ({ itemId: item.itemId, annotation: {
            explanation: '说明此项', basis: '来自已提供规则', impact: '核查差异', recommendation: '请核对' } })), answer: '本组说明已生成，仍需用户确认。' }) };
        aiJobs.set(job.id, job); return { ...job, status: 'running' };
      },
      snapshot(id) { const job = aiJobs.get(id); if (!job) throw new Error('missing job'); return job; }
    };
    const assist = new LiteratureRuleReviewAssist(store, codex);
    let auxiliaryBusy = false;
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const from = server.indexOf('async function handleLiterature('), to = server.indexOf('\nfunction normalizeMessages(', from);
    assert.ok(from > 0 && to > from);
    const context = vm.createContext({ JSON, console, codex, MAX_BODY_BYTES: 2 * 1024 * 1024, MAX_REVIEW_BODY_BYTES, literatureRuleReviews: store, literatureRuleReviewAssist: assist,
      normalizeLiteratureConfig: normalizeConfig,
      literatureAuxiliary: { assertIdle() { if (auxiliaryBusy) throw Object.assign(new Error('fixture auxiliary operation in progress'), { status: 409 }); }, acquire() {
        assert.equal(auxiliaryBusy, false); auxiliaryBusy = true; return () => { auxiliaryBusy = false; };
      } },
      scholar: { start(config, resume, until, snapshot) { calls.push({ config, resume, until, snapshot }); return { id: randomUUID(), config, until }; } },
      readBody: async (req, limit) => { if (Buffer.byteLength(req.body, 'utf8') > limit) throw new Error('请求体过大'); return req.body; },
      sendJson(res, status, data) { res.status = status; res.data = data; } });
    vm.runInContext(server.slice(from, to), context);
    const route = async (name, body, method = 'POST') => {
      const res = {}; await context.handleLiterature({ method, body: JSON.stringify(body || {}) }, res, new URL('http://fixture/api/literature/' + name)); return res;
    };
    const config = { topic: '核查路由测试', query: 'broiler temperature', sources: ['google-scholar'],
      publicationYearFrom: 2000, language: '中文、英文', searchMode: 'formal', stopMode: 'end',
      inclusion: Array.from({ length: 45 }, (_, index) => '规则' + (index + 1) + '：' + '同组同期间核查气候影响。'.repeat(65)) };
    assert.ok(Buffer.byteLength(JSON.stringify(config), 'utf8') > 64 * 1024, 'Fixture must cover the former search body limit');
    let response = await route('rule-review/create', { sessionId, workspaceId, config, until: 'discover',
      source: 'fixture-source', context: { messages: [{ role: 'user', text: '2000年起，中英文；先仅检索候选。' }], approvedDoc: '' } });
    assert.equal(response.status, 201, JSON.stringify(response.data)); let review = response.data;
    assert.equal(review.ready, false); assert.equal(calls.length, 0);
    assert.equal((await route('rule-review?id=' + review.id + '&sessionId=' + randomUUID(), null, 'GET')).status, 403);
    assert.equal((await route('search', { config, until: 'discover' })).status, 409);
    const request = () => ({ sessionId, workspaceId, reviewId: review.id, reviewRevision: review.revision, config: review.config, until: review.until });
    assert.equal((await route('search', request())).status, 409);
    response = await route('rule-review/assist', { id: review.id, sessionId, revision: review.revision, mode: 'group', groupId: 'scope' });
    assert.equal(response.status, 202); const aiJob = response.data;
    response = await route('rule-review/assist-result', { id: review.id, sessionId, revision: review.revision, jobId: aiJob.id });
    assert.equal(response.status, 200); review = response.data;
    assert.equal(review.progress.confirmed, 0, 'AI must never confirm a rule');
    assert.equal(review.items[0].annotation.explanation, '说明此项');
    response = await route('rule-review/assist', { id: review.id, sessionId, revision: review.revision, mode: 'explain', itemId: 'topic' });
    const invalidAI = response.data;
    aiJobs.get(invalidAI.id).text = JSON.stringify({ annotations: [], answer: '已经确认', config: { query: 'injected' } });
    const beforeInvalidAI = review.revision;
    response = await route('rule-review/assist-result', { id: review.id, sessionId, revision: review.revision, jobId: invalidAI.id });
    assert.equal(response.status, 400);
    assert.equal((await store.get(review.id, sessionId)).revision, beforeInvalidAI, 'Malformed AI output cannot update or confirm any rule');
    assert.equal((await route('rule-review/assist-result', { id: review.id, sessionId, revision: review.revision, jobId: randomUUID() })).status, 409);
    response = await route('rule-review/action', { id: review.id, sessionId, revision: review.revision - 1, action: 'confirm', itemId: 'topic' });
    assert.equal(response.status, 409, 'Stale request cannot replace saved review');
    for (const group of review.groups) {
      response = await route('rule-review/action', { id: review.id, sessionId, revision: review.revision, action: 'group-confirm', groupId: group.id });
      assert.equal(response.status, 200); review = response.data;
    }
    assert.equal(review.ready, true);
    assert.equal((await route('search', { ...request(), workspaceId: 'other-task' })).status, 403);
    assert.equal((await route('search', { ...request(), until: 'extract' })).status, 409);
    assert.equal((await route('search', { ...request(), config: { ...review.config, query: 'different query' } })).status, 409);
    assert.equal(calls.length, 0, 'Every failed validation must precede the runner');
    response = await route('search', request()); assert.equal(response.status, 202);
    assert.equal(calls.length, 1); assert.equal(calls[0].snapshot.revision, review.revision);
    assert.deepEqual(calls[0].config, review.config); assert.equal(calls[0].until, 'discover');
    // Store survives replacement of the service object (server restart).
    assert.equal((await new LiteratureRuleReviewStore(temp).get(review.id, sessionId)).ready, true);
    // Verify the real connector writes confirmation evidence before invoking a worker.
    const connector = new LiteratureConnector(temp);
    let workerCalled = false;
    connector.run = async job => {
      workerCalled = true;
      const snapshot = JSON.parse(fs.readFileSync(path.join(job.dir, 'rule-review-confirmed.json'), 'utf8'));
      assert.equal(snapshot.reviewId, review.id);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job.dir, 'run_config.json'), 'utf8')), review.config);
    };
    const frozen = await store.execution({ id: review.id, sessionId, workspaceId, revision: review.revision, config: review.config, until: review.until });
    const job = connector.start(frozen.config, false, frozen.until, frozen.snapshot);
    assert.equal(workerCalled, true); assert.ok(job.files.includes('rule-review-confirmed.json'));
    assert.throws(() => connector.start(frozen.config, false, 'extract', frozen.snapshot), /运行|配置|核查/);
    // Fork is a new editable review, not an advance/start of the frozen job.
    context.scholar.jobs = connector.jobs;
    let forkRequest = { jobId: job.id, sessionId, workspaceId, requestId: randomUUID() };
    assert.equal((await route('rule-review/fork', forkRequest)).status, 409, 'A live running source cannot be forked');
    assert.equal(auxiliaryBusy, false, 'The auxiliary lock releases on a rejected fork');
    const parent = connector.jobs.get(job.id); parent.status = 'needs_attention'; connector.persist(parent);
    parent.browserOpening = true;
    assert.equal((await route('rule-review/fork', { ...forkRequest, jobId: job.id.toUpperCase() })).status, 409, 'Uppercase UUID spelling cannot bypass the live-state guard');
    parent.browserOpening = false;
    const parentBytes = fs.readFileSync(path.join(parent.dir, 'job.json'), 'utf8');
    const originalReviewBytes = fs.readFileSync(path.join(temp, '.workbench', 'literature-rule-reviews', review.id, 'review.json'), 'utf8');
    const beforeCalls = calls.length;
    response = await route('rule-review/fork', forkRequest); assert.equal(response.status, 201, JSON.stringify(response.data));
    const forked = response.data;
    assert.equal(forked.ready, true); assert.equal(forked.progress.confirmed, 14); assert.equal(forked.parentJobId, job.id);
    assert.equal(forked.parentReviewId, review.id); assert.equal(forked.parentRevision, review.revision);
    assert.equal(calls.length, beforeCalls); assert.equal(connector.jobs.size, 1, 'Creating a review never invokes a worker or creates a literature job');
    assert.equal((await route('rule-review/fork', forkRequest)).data.id, forked.id);
    assert.equal(auxiliaryBusy, false);
    let releaseRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; }), readSnapshot = store._jobSnapshot;
    store._jobSnapshot = async function (...args) { await readGate; return readSnapshot.apply(this, args); };
    const waitingFork = route('rule-review/fork', { ...forkRequest, requestId: randomUUID() });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(auxiliaryBusy, true);
    assert.equal((await route('search', request())).status, 409, 'The parent is protected while its frozen files are being read');
    releaseRead(); assert.equal((await waitingFork).status, 201); store._jobSnapshot = readSnapshot;
    assert.equal(auxiliaryBusy, false); assert.equal(calls.length, beforeCalls);
    assert.equal((await route('rule-review/fork', { ...forkRequest, workspaceId: 'wrong' })).status, 403);
    assert.equal((await route('rule-review/fork', { ...forkRequest, snapshot: frozen.snapshot })).status, 400);
    const changedBasis = await route('rule-review/fork', { ...forkRequest, requestId: randomUUID(), source: 'new-discussion-source' });
    assert.equal(changedBasis.status, 201); assert.equal(changedBasis.data.ready, false); assert.equal(changedBasis.data.progress.confirmed, 0);
    response = await route('rule-review/action', { id: forked.id, sessionId, revision: forked.revision, action: 'edit', itemId: 'query', value: { query: 'broiler humidity' } });
    assert.equal(response.status, 200); let updated = response.data;
    assert.equal(updated.progress.confirmed, 12);
    const forkSearch = () => ({ sessionId, workspaceId, reviewId: updated.id, reviewRevision: updated.revision, config: updated.config, until: updated.until, resumeCurrent: true });
    assert.equal((await route('search', forkSearch())).status, 409, 'Changed and dependent items must be re-confirmed');
    for (const item of updated.items.filter(item => item.status !== 'confirmed')) {
      response = await route('rule-review/action', { id: updated.id, sessionId, revision: updated.revision, action: 'confirm', itemId: item.id }); updated = response.data;
    }
    response = await route('search', forkSearch()); assert.equal(response.status, 202);
    assert.equal(calls.at(-1).snapshot.parentJobId, job.id);
    const newExecution = await store.execution({ id: updated.id, sessionId, workspaceId, revision: updated.revision, config: updated.config, until: updated.until });
    let ranFrom;
    connector.run = async (created, fromStage) => { ranFrom = fromStage; };
    const newJob = connector.start(newExecution.config, true, newExecution.until, newExecution.snapshot);
    const newLive = connector.jobs.get(newJob.id);
    assert.notEqual(newJob.id, job.id); assert.equal(newJob.parentJobId, job.id); assert.equal(newJob.parentReviewId, review.id);
    assert.equal(newLive.resumeCurrent, false, 'A fork cannot reuse a previous browser/page checkpoint');
    assert.equal(newLive.resumeRun, false); assert.equal(ranFrom, 'discover'); assert.equal(newLive.count, 0);
    assert.ok(!fs.existsSync(path.join(newLive.dir, 'candidates.json')));
    newLive.status = 'needs_attention'; connector.persist(newLive);
    const reloaded = new LiteratureConnector(temp);
    assert.equal(reloaded.snapshot(newJob.id).parentJobId, job.id);
    assert.equal(reloaded.loadPersisted(newJob.id).parentReviewId, review.id);
    assert.equal(reloaded.public(reloaded.jobs.get(newJob.id)).parentRevision, review.revision);
    assert.equal(fs.readFileSync(path.join(parent.dir, 'job.json'), 'utf8'), parentBytes);
    assert.equal(fs.readFileSync(path.join(temp, '.workbench', 'literature-rule-reviews', review.id, 'review.json'), 'utf8'), originalReviewBytes);
    const targetSession = randomUUID(), targetWorkspace = 'loaded-history-context'; knownSessions.add(targetSession);
    const historyRequest = { jobId: job.id, sessionId: targetSession, workspaceId: targetWorkspace, requestId: randomUUID(),
      source: review.source, context: review.context };
    assert.equal((await route('rule-review/fork', historyRequest)).status, 403, 'Default cross-context requests must remain forbidden');
    const imported = await route('rule-review/fork', { ...historyRequest, fromHistory: true });
    assert.equal(imported.status, 201, JSON.stringify(imported.data)); assert.equal(imported.data.sessionId, targetSession);
    assert.equal(imported.data.workspaceId, targetWorkspace); assert.equal(imported.data.sourceSessionId, sessionId); assert.equal(imported.data.sourceWorkspaceId, workspaceId);
    assert.equal(imported.data.history[0].action, 'import-history'); assert.equal(imported.data.progress.confirmed, 14);
    assert.equal((await route('rule-review/fork', { ...historyRequest, fromHistory: true })).data.id, imported.data.id);
    assert.equal((await route('rule-review/fork', { ...historyRequest, fromHistory: true, sessionId: randomUUID() })).status, 400, 'History imports still validate the destination through codex.session');
    const changedHistory = await route('rule-review/fork', { ...historyRequest, fromHistory: true, requestId: randomUUID(),
      context: { messages: [{ role: 'user', text: 'Current history workspace has different requirements.' }], approvedDoc: '' } });
    assert.equal(changedHistory.status, 201); assert.equal(changedHistory.data.progress.confirmed, 0);
    assert.equal(fs.readFileSync(path.join(parent.dir, 'job.json'), 'utf8'), parentBytes);
    assert.equal(fs.readFileSync(path.join(temp, '.workbench', 'literature-rule-reviews', review.id, 'review.json'), 'utf8'), originalReviewBytes);
    console.log('PASS rule review routes: durable decisions, frozen evidence, owned/idempotent review forks, changed/dependent re-confirmation, fresh-job lineage without checkpoint reuse');
  } finally {
    assert.ok(path.resolve(temp).startsWith(root + path.sep + '.test-literature-review-routes-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
