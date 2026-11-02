'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteratureConnector } = require('./literature-connector');

const config = { topic: 'Scholar预试', query: 'broiler "heat stress"', sources: ['google-scholar'],
  publicationYearFrom: 2020, publicationYearTo: 2024, searchMode: 'formal', stopMode: 'end', perSourceLimit: null,
  scholarPlan: { version: 1, topics: [{ id: 'broiler-heat', label: '肉鸡热应激', query: 'broiler "heat stress"' }],
    yearSpan: 5, sort: 'relevance', trialMaxPages: 2 } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholar-connector-'));
const c = new LiteratureConnector(root, { prepare: async () => { throw new Error('isolated test must not prepare an actual run'); } });
assert.throws(() => c.start(config, false, 'fulltext'), /预试.*候选|预试.*discover/);
const dir = path.join(root, 'fixture');
fs.mkdirSync(dir);
const job = { id: 'fixture', dir, config, runId: 1, status: 'running', stage: 'discover',
  files: [], events: [], stages: { discover: 'running' }, count: 0, counters: {}, deferredSources: [] };
const progress = { source: 'google-scholar', batchLabel: '肉鸡热应激', pagesSaved: 2, nextPage: 3,
  processedBatches: 0, pendingBatches: 1, coverageGaps: 0, status: 'trial_complete', trialMaxPages: 2 };
c.onStageEvent(job, 1, 'discover', { type: 'result', stage: 'completed', count: 20, files: [],
  trial_complete: true, discovery_complete: false, discoveryProgress: progress, message: '两页预试结束，覆盖未完成' });
assert.equal(job.status, 'running', '预试完成不应伪装成需登录/验证');
assert.equal(job.stages.discover, 'done');
assert.equal(c.public(job).discoveryProgress.pagesSaved, 2);
console.log('Scholar connector trial boundary/progress checks passed');
