'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runScreeningStage, loadInputs, selectInputs } = require('./literature-screening');
const ACCESS = new Set(['verification', 'login', 'access_required', 'rate_limited', 'access_blocked']);
const attention = (reason, message) => Object.assign(new Error(message), { code: 'SCREENING_ATTENTION', reason });
const METADATA_TERMINAL = new Set(['verified', 'missing', 'identity_mismatch', 'abstract_incomplete', 'no_entry']);
const ACCESS_MESSAGES = {
  verification: '摘要页面检测到可见的安全验证，已保留原页面和断点。请在原页面完成验证，再点击“继续获取全文”。',
  login: '摘要页面要求登录，已保留原页面和断点。请在原页面登录，再点击“继续获取全文”。',
  access_required: '摘要页面提示访问权限不足，已保留原页面和断点。请核对机构访问权限后继续。',
  rate_limited: '数据库提示访问过于频繁，已保留原页面和断点。请等待限制解除后继续。',
  access_blocked: '数据库限制了当前页面访问，已保留原页面和断点。请核对原页面提示后继续。',
};

function metadataCheckpoint(jobDir, candidateIds) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(jobDir, 'metadata', 'status.json'), 'utf8'));
    return new Set(Object.entries(state.items || {}).filter(([id, item]) => (!candidateIds || candidateIds.includes(id)) && METADATA_TERMINAL.has(item.status))
      .map(([id, item]) => JSON.stringify([id, item.record_sha256, item.status])));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw attention('screening_metadata_incomplete', '摘要回源断点无法核验，未自动续批。');
  }
}

function cnkiProbeCheckpoint(jobDir, candidateIds) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(jobDir, 'metadata', 'status.json'), 'utf8'));
    return new Map(Object.entries(state.items || {}).filter(([id, item]) => {
      const point = item?.cnki_probe_checkpoint;
      return (!candidateIds || candidateIds.includes(id)) && item?.status === 'attention'
        && item.reason === 'cnki_version_probe_budget' && /^[a-f0-9]{64}$/.test(item.record_sha256 || '')
        && /^[a-f0-9]{64}$/.test(point?.key || '') && Number.isSafeInteger(point?.step)
        && Number.isSafeInteger(point?.max_steps) && point.step > 0 && point.step <= point.max_steps
        && point.max_steps > 0 && point.max_steps <= 153;
    }).map(([id, item]) => [id, { record: item.record_sha256, ...item.cnki_probe_checkpoint }]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw attention('screening_metadata_incomplete', '同名文献核对断点无法核验，未自动继续。');
  }
}

function cnkiProbeProgressed(before, after) {
  return [...after].some(([id, point]) => {
    const previous = before.get(id);
    return !previous || (point.record === previous.record && point.key === previous.key
      && point.max_steps === previous.max_steps && point.step > previous.step);
  });
}

// Metadata completion is a separate checkpoint. Its result cannot mark fulltext
// done, and a blocked source must not immediately receive download requests.
async function runScreeningPipeline({ root, bridge, job, onEvent = () => {}, signal, runMetadata,
  screen = runScreeningStage, paperIds }) {
  // The caller's already-selected boundary authorizes continuation, never a
  // discover-only task. Access restrictions and real failures remain stops.
  const autoContinue = ['fulltext', 'extract', 'validate', 'export'].includes(job.until);
  const checkCancelled = () => {
    if (signal?.aborted || job.status === 'cancelled') throw attention('screening_cancelled', '任务已停止，已完成断点保留，未继续下载。');
  };
  checkCancelled();
  const selected = paperIds === undefined ? null : selectInputs(loadInputs(job.dir), paperIds);
  const selectedIds = selected?.map(bundle => bundle.paper_id);
  // Exact duplicate bundles may contain several source records. Retrieve
  // every original abstract belonging to the selected bundle before judging.
  const candidateIds = selected ? [...new Set(selected.flatMap(bundle => bundle.documents.map(document => document.source_id)))] : null;
  const sameIds = (left, right) => Array.isArray(left) && left.length === right.length
    && new Set(left).size === left.length && left.every(id => right.includes(id));
  let metadataBatch = 0;
  for (;;) {
    checkCancelled();
    const before = autoContinue ? metadataCheckpoint(job.dir, candidateIds) : null;
    const beforeProbe = autoContinue ? cnkiProbeCheckpoint(job.dir, candidateIds) : null;
    let metadata;
    const args = ['--total-budget-sec', '300', '--per-record-timeout-sec', '30'];
    if (candidateIds) args.push('--only', JSON.stringify(candidateIds));
    // Only an explicit resume retries an earlier access barrier. Subsequent
    // automatic budget batches must not acquire this permission implicitly.
    if (job.resumeRun === true && metadataBatch === 0) args.push('--retry-attention');
    await runMetadata(args, event => {
      if (signal?.aborted) return;
      if (event.type === 'result') {
        metadata = event;
        onEvent({ type: 'stage', stage: 'metadata', message: event.message || '摘要回源状态已保存。', files: ['metadata/status.json'] });
      } else onEvent(event);
    });
    checkCancelled();
    if (metadata?.ok !== true) throw attention('screening_metadata_incomplete', '摘要回源未返回可核对的状态，未开始下载。');
    if (ACCESS.has(metadata.stop_reason)) throw attention('screening_metadata_access', ACCESS_MESSAGES[metadata.stop_reason]);
    if (candidateIds && !sameIds(metadata.selected_candidate_ids, candidateIds)) throw attention('screening_scope_invalid', '摘要回源返回的文献范围与本批不一致，未开始筛选或下载。');
    if (metadata.complete === false && metadata.pending_count > 0) {
      if (metadata.stop_reason === 'cnki_version_probe_budget') {
        if (!autoContinue || !cnkiProbeProgressed(beforeProbe, cnkiProbeCheckpoint(job.dir, candidateIds))) {
          throw attention('screening_metadata_budget', '同名文献核对本轮没有新增可核验进展，已保留页面和断点，请检查后继续。');
        }
        metadataBatch += 1;
        onEvent({ type: 'stage', stage: 'metadata', reason: 'cnki_probe_budget_checkpoint', batch: metadataBatch,
          message: '本页同名文献的逐条核对进展已保存，自动接续下一步；尚未作纳排或下载判断。', files: ['metadata/status.json'] });
        continue;
      }
      if (metadata.stop_reason === 'page_not_ready') throw attention('screening_metadata_page_not_ready',
        metadata.message || '摘要原页面尚未提供可核对的文献身份，原页面与断点保留；稍后点击继续，尚未进入初筛或下载。');
      if (metadata.stop_reason === 'page_error') throw attention('screening_metadata_page_error',
        metadata.message || '摘要原页面或文献定位无法核对，原页面与断点保留；请检查后继续。');
      const progressed = autoContinue && metadata.stop_reason === 'total_budget_exhausted'
        && [...metadataCheckpoint(job.dir, candidateIds)].some(key => !before.has(key));
      if (!progressed) throw attention('screening_metadata_budget', '本轮摘要回源预算已用完或没有新的已保存进展。断点已保留，请检查后继续。');
      metadataBatch += 1;
      onEvent({ type: 'stage', stage: 'metadata', reason: 'metadata_budget_checkpoint', batch: metadataBatch,
        message: `摘要回源本批进展已保存，自动继续下一批；尚余 ${metadata.pending_count} 条。`, files: ['metadata/status.json'] });
      continue;
    }
    break;
  }
  let screeningBatch = 0;
  for (;;) {
    checkCancelled();
    let budgetEvent;
    try {
      const result = await screen({ root, bridge, jobDir: job.dir, config: job.config, signal,
        ...(selectedIds ? { paperIds: selectedIds } : {}), onEvent: event => {
        // A budget checkpoint must not set the connector to needs_attention
        // before we can verify that a further authorized batch is possible.
        if (autoContinue && event.type === 'attention' && event.reason === 'screening_budget') budgetEvent = event;
        else onEvent(event);
      } });
      if (selectedIds && !sameIds(result?.selectedPaperIds, selectedIds)) throw attention('screening_scope_invalid', '筛选返回的文献范围与本批不一致，未开始下载。');
      return result;
    } catch (error) {
      checkCancelled();
      if (!autoContinue || error.code !== 'SCREENING_ATTENTION' || error.reason !== 'screening_budget') throw error;
      if (!(Number.isSafeInteger(error.completedThisBatch) && error.completedThisBatch > 0)) {
        if (budgetEvent) onEvent(budgetEvent);
        throw error;
      }
      screeningBatch += 1;
      onEvent({ type: 'stage', stage: 'screening', reason: 'screening_budget_checkpoint', batch: screeningBatch,
        message: `本批新增 ${error.completedThisBatch} 篇判定已保存，自动继续下一批。`, files: ['screening/status.json'] });
    }
  }
}

module.exports = { runScreeningPipeline };
