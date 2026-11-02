'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScreeningPipeline } = require('./literature-screening-pipeline');

async function test() {
  let screened = 0, args, events = [];
  const controller = new AbortController();
  const base = { root: '.', bridge: {}, job: { dir: '.', config: {} }, signal: controller.signal,
    onEvent: e => events.push(e), screen: async () => { screened++; return { ok: true }; } };
  async function invoke(result, override = {}) {
    return runScreeningPipeline({ ...base, runMetadata: async (a, emit) => { args = a; if (result) emit({ type: 'result', stage: 'metadata', ...result }); }, ...override });
  }
  assert.deepEqual(await invoke({ ok: true, complete: true, counts: { unresolved_abstracts: 2 } }), { ok: true });
  assert.equal(screened, 1, 'Terminal missing abstracts proceed to pending screening');
  assert.equal(events.some(e => e.type === 'result'), false, 'Metadata result never completes fulltext');
  assert.equal(events[0].files[0], 'metadata/status.json');
  for (const stop_reason of ['verification', 'login', 'rate_limited', 'access_blocked']) {
    await assert.rejects(invoke({ ok: true, complete: false, stop_reason, pending_count: 1 }), e => e.reason === 'screening_metadata_access');
  }
  const accessLabels = { verification: '可见的安全验证', login: '要求登录', access_required: '访问权限不足', rate_limited: '访问过于频繁', access_blocked: '限制了当前页面访问' };
  for (const [stop_reason, label] of Object.entries(accessLabels)) {
    await assert.rejects(invoke({ ok: true, complete: false, stop_reason, pending_count: 1, message: '摘要证据已保存。' }),
      e => e.reason === 'screening_metadata_access' && e.message.includes(label) && !e.message.includes('登录、验证或暂停访问'));
  }
  await assert.rejects(invoke({ ok: true, complete: false, stop_reason: 'total_budget_exhausted', pending_count: 5 }), e => e.reason === 'screening_metadata_budget');
  for (const stop_reason of ['page_not_ready', 'page_error']) {
    await assert.rejects(invoke({ ok: true, complete: false, stop_reason, pending_count: 1, message: '保留原页面等待核对' }),
      e => e.reason === `screening_metadata_${stop_reason}` && e.message === '保留原页面等待核对');
  }
  await assert.rejects(invoke(null), e => e.reason === 'screening_metadata_incomplete');
  assert.equal(screened, 1);
  await invoke({ ok: true, complete: true }, { job: { ...base.job, resumeRun: true } });
  assert.ok(args.includes('--retry-attention'));
  controller.abort();
  let requested = false;
  await assert.rejects(invoke(null, { runMetadata: async () => { requested = true; } }), e => e.reason === 'screening_cancelled');
  assert.equal(requested, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screening-batch-test-'));
  try {
    const metadataFile = path.join(dir, 'metadata', 'status.json');
    fs.mkdirSync(path.dirname(metadataFile));
    const checkpoint = items => fs.writeFileSync(metadataFile, JSON.stringify({ items }));
    const terminal = id => ({ record_sha256: id, status: 'verified' });
    let calls = 0, seenScreen = 0, batchEvents = [], metadataArgs = [];
    const auto = { root: '.', bridge: {}, job: { dir, until: 'fulltext', status: 'running', resumeRun: true, config: {} },
      onEvent: event => { batchEvents.push(event); if (event.type === 'attention') auto.job.status = 'needs_attention'; },
      screen: async () => { seenScreen++; return { ok: true }; } };
    fs.writeFileSync(metadataFile, '{broken');
    await assert.rejects(runScreeningPipeline({ ...auto, runMetadata: async () => { throw new Error('must not run'); } }),
      e => e.reason === 'screening_metadata_incomplete' && e.message.includes('断点无法核验'));
    checkpoint({});
    await runScreeningPipeline({ ...auto, runMetadata: async (a, emit) => {
      metadataArgs.push(a); calls++;
      checkpoint(Object.fromEntries(Array.from({ length: calls }, (_, i) => ['R' + i, terminal('R' + i)])));
      emit({ type: 'result', ok: true, complete: calls === 3, stop_reason: calls === 3 ? '' : 'total_budget_exhausted', pending_count: 3 - calls });
    } });
    assert.equal(calls, 3); assert.equal(seenScreen, 1);
    assert.equal(batchEvents.filter(e => e.reason === 'metadata_budget_checkpoint').length, 2);
    assert.equal(auto.job.status, 'running', 'internal budget batches must not pause connector');
    assert.ok(metadataArgs[0].includes('--retry-attention'));
    assert.ok(metadataArgs.slice(1).every(a => !a.includes('--retry-attention')), 'auto batches cannot inherit access retry permission');

    // A budget result without a newly durable terminal record cannot loop.
    calls = 0;
    await assert.rejects(runScreeningPipeline({ ...auto, runMetadata: async (_, emit) => {
      calls++; emit({ type: 'result', ok: true, complete: false, stop_reason: 'total_budget_exhausted', pending_count: 5, attempted: 2 });
    } }), e => e.reason === 'screening_metadata_budget');
    assert.equal(calls, 1); assert.equal(seenScreen, 1);
    for (const stop_reason of ['verification', 'login', 'access_required', 'rate_limited', 'access_blocked']) {
      await assert.rejects(runScreeningPipeline({ ...auto, runMetadata: async (_, emit) => {
        emit({ type: 'result', ok: true, complete: false, stop_reason, pending_count: 1 });
      } }), e => e.reason === 'screening_metadata_access');
    }
    checkpoint({}); calls = 0;
    await assert.rejects(runScreeningPipeline({ ...auto, job: { ...auto.job, until: 'discover' }, runMetadata: async (_, emit) => {
      calls++; checkpoint({ R1: terminal('R1') });
      emit({ type: 'result', ok: true, complete: false, stop_reason: 'total_budget_exhausted', pending_count: 1 });
    } }), e => e.reason === 'screening_metadata_budget');
    assert.equal(calls, 1, 'discover boundary is never expanded');

    const completeMetadata = async (_, emit) => emit({ type: 'result', ok: true, complete: true });
    const budget = count => Object.assign(new Error('budget'), { code: 'SCREENING_ATTENTION', reason: 'screening_budget', completedThisBatch: count });
    calls = 0; batchEvents = [];
    await runScreeningPipeline({ ...auto, runMetadata: completeMetadata, screen: async ({ onEvent }) => {
      calls++;
      if (calls === 3) return { ok: true };
      onEvent({ type: 'attention', reason: 'screening_budget' }); throw budget(1);
    } });
    assert.equal(calls, 3); assert.equal(auto.job.status, 'running');
    assert.equal(batchEvents.filter(e => e.reason === 'screening_budget_checkpoint').length, 2);
    assert.equal(batchEvents.some(e => e.type === 'attention'), false);

    calls = 0;
    await assert.rejects(runScreeningPipeline({ ...auto, runMetadata: completeMetadata, screen: async ({ onEvent }) => {
      calls++; onEvent({ type: 'attention', reason: 'screening_budget' }); throw budget(0);
    } }), e => e.reason === 'screening_budget');
    assert.equal(calls, 1); assert.equal(auto.job.status, 'needs_attention'); auto.job.status = 'running';
    for (const reason of ['screening_timeout', 'screening_output_invalid', 'screening_model_error']) {
      calls = 0;
      await assert.rejects(runScreeningPipeline({ ...auto, runMetadata: completeMetadata, screen: async () => {
        calls++; throw Object.assign(new Error(reason), { code: 'SCREENING_ATTENTION', reason, completedThisBatch: 5 });
      } }), e => e.reason === reason);
      assert.equal(calls, 1, 'real model problems must not be automatic retries');
    }

    for (const stage of ['metadata', 'screening']) {
      const stop = new AbortController(); calls = 0; checkpoint({});
      await assert.rejects(runScreeningPipeline({ ...auto, signal: stop.signal,
        onEvent: e => { if (e.reason?.endsWith('_checkpoint')) stop.abort(); },
        runMetadata: stage === 'screening' ? completeMetadata : async (_, emit) => {
          calls++; checkpoint({ R1: terminal('R1') });
          emit({ type: 'result', ok: true, complete: false, stop_reason: 'total_budget_exhausted', pending_count: 1 });
        }, screen: async ({ onEvent }) => {
          calls++; onEvent({ type: 'attention', reason: 'screening_budget' }); throw budget(1);
        } }), e => e.reason === 'screening_cancelled');
      assert.equal(calls, 1, 'cancellation between batches prevents new work');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('Metadata → screening pipeline: completion, bounded pause, access stop, explicit resume and cancellation passed');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
