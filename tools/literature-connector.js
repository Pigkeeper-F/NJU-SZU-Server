'use strict';

// 文献挖掘连接器（第二阶段：六阶段 steps 编排 + advance 续跑 + 交付物登记）。
// 契约：docs/literature-mining-stage2-design.md §1.2/§3/§4/§8/§9.6、docs/contract.md §21。
// 向后兼容：start() 缺省 until=discover 时与第一阶段行为逐字一致（不回归清单见设计 §10）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { normalizeConfig, discoverBudget, MAX_FIELD_DEFINITIONS } = require('./literature-config');
const { executableSources } = require('./literature-sources');
const { proxyFor } = require('./source-download');
const { readMaterials, registeredMaterialFile, safeFile } = require('./literature-materials');
const materialReplenishment = require('./literature-material-replenishment');
const segmentTasks = require('./literature-segment');

function childEnv() {
  const proxy = proxyFor('https:');
  return { ...process.env, PYTHONIOENCODING: 'utf-8', ...(proxy ? { HTTPS_PROXY: proxy.href, HTTP_PROXY: proxy.href } : {}) };
}

const ID = /^[a-f0-9-]{36}$/;
const CANDIDATE_FILES = ['candidates.json', 'candidates.csv'];
function availableCandidateFiles(dir, files) {
  // Read-only recovery for a discovery cancelled before its final result event.
  // Only these two fixed deliverables may be discovered; safeFile enforces the
  // same regular-file and no-symlink boundary as downloading an existing entry.
  const available = CANDIDATE_FILES.filter(name => safeFile(dir, name));
  return [...new Set([...(Array.isArray(files) ? files : []).filter(name => !CANDIDATE_FILES.includes(name) || available.includes(name)), ...available])];
}
function reviewLineage(value) {
  if (!value?.parentJobId) return {};
  if (!ID.test(value.parentJobId) || !ID.test(value.parentReviewId || '') || !Number.isSafeInteger(value.parentRevision) || value.parentRevision < 1) throw new Error('修改配置的原任务核查关联无效');
  return { parentJobId: value.parentJobId, parentReviewId: value.parentReviewId, parentRevision: value.parentRevision };
}

//: 账号与权限入口白名单（2026-11-06 从万方两键扩到五库 + EZproxy）。
//: institution/purchase 保留原键名，避免旧调用与历史文案失效。
const ACCESS_TARGETS = ['institution', 'purchase', 'cnki', 'wos', 'scopus', 'ezproxy'];
const ACCESS_STATUS_SOURCES = ['wanfang', 'cnki', 'wos', 'scopus', 'ezproxy', 'all'];

//: 六阶段冻结顺序（设计 §2；与 tools/literature-common.py STAGES 一致）
const STAGES = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];

function isScholarTrial(config) {
  return Number.isSafeInteger(config?.scholarPlan?.trialMaxPages) && config.scholarPlan.trialMaxPages > 0;
}

function assertScholarTrialScope(config, from, until) {
  if (isScholarTrial(config) && (from !== 'discover' || until !== 'discover'
      || config.sources?.length !== 1 || config.sources[0] !== 'google-scholar')) {
    throw new Error('谷歌学术预试只能获取候选（discover），不能启动其他来源或后续阶段');
  }
}

function safeDiscoveryProgress(raw) {
  if (!raw || raw.source !== 'google-scholar') return null;
  const value = { source: 'google-scholar' };
  for (const key of ['batchLabel', 'batchId', 'recoveryMessage']) {
    value[key] = typeof raw[key] === 'string' ? raw[key].slice(0, 1000) : null;
  }
  for (const key of ['yearFrom', 'yearTo', 'pagesSaved', 'nextPage', 'processedBatches', 'pendingBatches', 'coverageGaps', 'trialMaxPages']) {
    value[key] = Number.isSafeInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 1000000 ? raw[key] : null;
  }
  value.status = ['pending', 'processed', 'coverage_limited', 'trial_complete'].includes(raw.status) ? raw.status : 'pending';
  return value;
}

function checkpointDiscoveryProgress(dir, config) {
  const state = loadJsonFile(path.join(dir, 'discovery-state.json'));
  const entry = state?.sources?.['google-scholar'];
  if (!entry) return null;
  const summary = entry.scholar_summary || {};
  const active = entry.scholar_schedule?.batches?.find(batch => batch.id === summary.current_batch_id)
    || entry.scholar_schedule?.batches?.find(batch => ['pending', 'running', 'attention'].includes(batch.status));
  return safeDiscoveryProgress({ source: 'google-scholar', batchLabel: active?.label || '原检索式', batchId: active?.id,
    yearFrom: active?.year_from ?? config?.publicationYearFrom, yearTo: active?.year_to ?? config?.publicationYearTo,
    pagesSaved: Array.isArray(entry.pages) ? entry.pages.length : null,
    nextPage: active ? active.next_page + 1 : Number.isSafeInteger(entry.next_page) ? entry.next_page + 1 : null,
    processedBatches: summary.processed_batches, pendingBatches: summary.pending_batches,
    coverageGaps: summary.coverage_limited_batches, trialMaxPages: config?.scholarPlan?.trialMaxPages,
    status: entry.trial_complete ? 'trial_complete' : summary.status || (entry.status === 'ok' ? 'processed' : 'pending'),
    recoveryMessage: entry.recovery?.message });
}

//: 阶段 → 脚本文件名（§2.4 冻结 CLI）
const STAGE_SCRIPTS = {
  discover: 'literature_search.py',
  dedupe: 'literature_dedupe.py',
  fulltext: 'literature_fulltext.py',
  extract: 'literature_extract.py',
  validate: 'literature_validate.py',
  export: 'literature_export.py'
};

//: 各阶段默认超时（秒；discover 每来源 180 秒，单来源保持既有文案）。
const STAGE_TIMEOUTS = { discover: 180, dedupe: 120, fulltext: 3600, extract: 1800, validate: 300, export: 600 };

const STAGE_LABELS = { discover: '候选检索', dedupe: '跨来源去重', fulltext: '全文获取', extract: '参数提取', validate: '校验', export: '导出' };

//: 交付物静态模式表（§9.6/§21.2.5）：result.files 命中模式且文件存在才登记进 job.files。
//: extraction/<id>.json 覆盖逐篇结果与 check_report.json（§4.1 目录树）。
const DELIVERABLE_PATTERNS = [
  /^run_config\.json$/,
  /^rule-review-confirmed\.json$/,
  /^research-basis\.json$/,
  /^screening\/status\.json$/,
  /^metadata\/status\.json$/,
  /^candidates\.(?:json|csv)$/,
  /^processing-basis\.json$/,
  /^materials-basis\.json$/,
  /^segment-basis\.json$/,
  /^dedupe\/dedupe\.(?:json|csv)$/,
  /^fulltext\/status\.json$/,
  /^fulltext\/review\.json$/,
  /^fulltext\/materials\.json$/,
  /^fulltext\/(?:manual-actions|skipped-materials)\.(?:json|csv|md)$/,
  /^fulltext\/materials\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[^\\]+$/,
  /^fulltext\/files\/[^/\\]+\.(?:pdf|txt)$/,
  /^extraction\/inputs\/[^/\\]+\.json$/,
  /^extraction\/[^/\\]+\.json$/,
  /^validation\/validation\.(?:json|md)$/,
  // 【文献调研 · 2026-10-20】环节①的调研产物：逐篇要点、共识分歧、研究空白、人工初筛记录。
  /^research\/(?:notes|synthesis|gaps|matrix)\.(?:json|csv|md)$/,
  /^research\/screening(?:_result)?\.json$/,
  // 【以文献找文献 · 2026-10-23】种子扩展的完整结果（含来源、关系与警告）。
  /^research\/seed_expansion\.json$/,
  /^export\/[^/\\]+\.(?:csv|xlsx|md)$/
];

function isDeliverable(name) {
  return typeof name === 'string' && DELIVERABLE_PATTERNS.some(pattern => pattern.test(name));
}

//: 全部 Python spawn 显式注入编码变量（§8.2 双防线之一）。
function pythonEnv() {
  return { ...childEnv(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function resolveLimits(config) {
  const limits = { ...STAGE_TIMEOUTS };
  limits.discover = discoverBudget(config);
  if (config && typeof config === 'object' && config.limits && typeof config.limits === 'object') {
    for (const stage of STAGES) {
      const value = config.limits[stage];
      if (Number.isInteger(value) && value > 0) limits[stage] = value;
    }
  }
  return limits;
}

function timeoutText(stage, seconds) {
  if (stage === 'discover' && seconds === 180) return '检索超过 3 分钟，已停止；如遇验证请手动完成后重试。';
  if (stage === 'fulltext') return `全文获取连续 ${seconds} 秒没有新的有效进展，已停止获取进程；已有材料和浏览器页面保留，请显式检查后再继续。`;
  return `阶段执行超过 ${seconds} 秒，已停止；已完成的产物保留。`;
}

function stageActivitySeconds(job, stage) {
  const configured = job.limits?.[stage] || STAGE_TIMEOUTS[stage] || 180;
  const basis = stage === 'fulltext' ? materialBasisFor(job.dir) : null;
  // Runtime allowance only: do not rewrite the parent's or child's frozen
  // configuration. Large batches retain the existing one-day process guard.
  return basis ? Math.max(configured, Math.min(86400, basis.candidateCount * 720)) : configured;
}

function fulltextActivity(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if ((Object.hasOwn(event, 'message') && typeof event.message !== 'string')
      || (Object.hasOwn(event, 'count') && (!Number.isSafeInteger(event.count) || event.count < 0))
      || (Object.hasOwn(event, 'counts') && (!event.counts || typeof event.counts !== 'object' || Array.isArray(event.counts)
        || !Object.values(event.counts).every(value => Number.isSafeInteger(value) && value >= 0)))) return null;
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  if (event.type === 'attention' && ['fulltext', 'verification'].includes(event.stage)
      && typeof event.reason === 'string' && event.reason && message) return { terminal: true };
  if (event.type === 'result' && event.stage === 'fulltext' && Number.isSafeInteger(event.count) && event.count >= 0) return { terminal: true };
  if (!['stage', 'progress'].includes(event.type) || event.stage !== 'fulltext') return null;
  const hasCount = Number.isSafeInteger(event.count) && event.count >= 0;
  const counts = event.counts && typeof event.counts === 'object' && !Array.isArray(event.counts) ? event.counts : null;
  const hasCounts = counts && Object.keys(counts).length && Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0);
  if (!message && !hasCount && !hasCounts) return null;
  return { signature: JSON.stringify([event.type, event.stage, event.paper_id || '', message, hasCount ? event.count : null, hasCounts ? counts : null]) };
}

function loadJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sourceAttention(value) {
  if (!value || typeof value !== 'object') return null;
  if (['deferred_materials', 'page_not_ready'].includes(value.reason) || String(value.reason || '').startsWith('screening_')) return { reason: value.reason };
  if (!executableSources().some(source => source.key === value.source)) return null;
  if (!['login', 'verification', 'access_required', 'results_unrecognized', 'rate_limited', 'access_blocked', 'native_query_required'].includes(value.reason)) return null;
  return { source: value.source, reason: value.reason };
}

function selectedSources(config) {
  const known = new Set(executableSources().map(source => source.key));
  return [...new Set((Array.isArray(config?.sources) ? config.sources : []).filter(source => typeof source === 'string' && known.has(source)))];
}

function deferredSources(value, config) {
  const selected = new Set(selectedSources(config));
  return [...new Set((Array.isArray(value) ? value : []).filter(source => selected.has(source)))];
}

function checkpointDeferredSources(dir, config, fallback = []) {
  const state = loadJsonFile(path.join(dir, 'discovery-state.json'));
  return deferredSources(state && Object.hasOwn(state, 'deferred_sources') ? state.deferred_sources : fallback, config);
}

function checkpointDeferredOnly(dir, config) {
  const state = loadJsonFile(path.join(dir, 'discovery-state.json'));
  const selected = selectedSources(config), queue = state?.deferred_sources;
  if (!selected.length || !Array.isArray(queue) || !queue.length || new Set(queue).size !== queue.length
      || queue.some(source => !selected.includes(source) || state?.sources?.[source]?.status !== 'attention')
      || !queue.includes(state?.pending_source)) return false;
  const remaining = selected.filter(source => !['ok', 'no_results'].includes(state?.sources?.[source]?.status));
  return remaining.length > 0 && remaining.every(source => queue.includes(source) && state?.sources?.[source])
    && queue.every(source => remaining.includes(source));
}

function candidateRecords(document) {
  const records = Array.isArray(document?.records) ? document.records : document?.results;
  return Array.isArray(records) && records.every(record => record && typeof record === 'object' && !Array.isArray(record)) ? records : null;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function frozenExecutionEvidence(dir, config) {
  const files = new Map(), same = (a, b) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
  for (const name of ['research-basis.json', 'rule-review-confirmed.json']) {
    const location = path.join(dir, name);
    if (!fs.existsSync(location)) {
      if (name === 'research-basis.json' && config.researchPlan) throw new Error('原任务缺少已确认研究依据，不能建立后续处理');
      continue; // Prepared research plans do not manufacture a 14-item review.
    }
    const entry = safeFile(dir, name);
    if (!entry || entry.size > 32 * 1024 * 1024) throw new Error('冻结执行依据文件无法安全核验：' + name);
    const bytes = fs.readFileSync(entry.file);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch (_) { throw new Error('冻结执行依据无法解析：' + name); }
    if (name === 'research-basis.json') {
      const plan = config.researchPlan;
      if (!plan || value?.schemaVersion !== 1 || value.presetId !== plan.presetId
          || value.boundDate !== plan.boundDate || value.bundleHash !== plan.bundleHash
          || !same(value.entry?.screeningPolicy, config.screeningPolicy)) throw new Error('研究依据与冻结配置不一致，未建立后续处理');
    } else {
      const { ITEMS } = require('./literature-rule-review');
      const all = { ...config, until: value?.until };
      if (!same(value?.config, config) || !STAGES.includes(value?.until)
          || !ID.test(value?.reviewId || '') || !Number.isSafeInteger(value?.revision) || value.revision < 1
          || value.fingerprint !== sha256(JSON.stringify(canonicalJson({ config, until: value.until })))
          || !Array.isArray(value.items) || value.items.length !== ITEMS.length
          || ITEMS.some(spec => {
            const matches = value.items.filter(item => item?.id === spec.id), item = matches[0];
            return matches.length !== 1 || item.status !== 'confirmed' || item.groupId !== spec.groupId
              || !same(item.value, Object.fromEntries(spec.keys.filter(key => Object.hasOwn(all, key)).map(key => [key, all[key]])));
          })) throw new Error('逐项核查依据与冻结配置不一致，未建立后续处理');
    }
    files.set(name, bytes);
  }
  return files;
}

function processingBasisFor(dir, config) {
  const basis = loadJsonFile(path.join(dir, 'processing-basis.json'));
  if (!basis || basis.version !== 1 || !ID.test(basis.parentJobId || '')
      || !Number.isSafeInteger(basis.candidateCount) || basis.candidateCount <= 0
      || typeof basis.createdAt !== 'string' || !Number.isFinite(Date.parse(basis.createdAt))
      || !Array.isArray(basis.deferredSources) || !basis.deferredSources.length
      || JSON.stringify(deferredSources(basis.deferredSources, config)) !== JSON.stringify(basis.deferredSources)) return null;
  try {
    const candidates = fs.readFileSync(path.join(dir, 'candidates.json'));
    const records = candidateRecords(JSON.parse(candidates.toString('utf8')));
    if (!records || records.length !== basis.candidateCount || sha256(candidates) !== basis.candidateSnapshotSha256
        || sha256(fs.readFileSync(path.join(dir, 'run_config.json'))) !== basis.configSnapshotSha256
        || sha256(fs.readFileSync(path.join(dir, 'candidates.csv'))) !== basis.candidateCsvSnapshotSha256) return null;
    if (basis.executionBasisSha256 !== undefined || config?.researchPlan) {
      const evidence = frozenExecutionEvidence(dir, config);
      const hashes = Object.fromEntries([...evidence].map(([name, bytes]) => [name, sha256(bytes)]));
      if (JSON.stringify(canonicalJson(hashes)) !== JSON.stringify(canonicalJson(basis.executionBasisSha256))) return null;
    }
  } catch (_) { return null; }
  return { parentJobId: basis.parentJobId, candidateCount: basis.candidateCount,
    deferredSources: [...basis.deferredSources], candidateSnapshotSha256: basis.candidateSnapshotSha256, createdAt: basis.createdAt };
}

function materialBasisFor(dir) {
  try { return materialReplenishment.readBasis(dir); } catch (_) { return null; }
}

function isMaterialRecord(job, dir) {
  return !!job?.materialReplenishment || job?.replenishmentInvalid === true || fs.existsSync(path.join(dir, materialReplenishment.MARKER));
}

function segmentBasisFor(dir) { try { return { ...segmentTasks.readBasis(dir), fieldsConfirmed: !!segmentTasks.fields(dir) }; } catch (_) { return null; } }
function isSegmentRecord(job, dir) { return !!job?.segmentTask || job?.segmentInvalid === true || fs.existsSync(path.join(dir, segmentTasks.MARKER)); }
function restoreSegmentScope(job, dir, interrupted = false) {
  const basis = segmentBasisFor(dir);
  if (!basis && !isSegmentRecord(job, dir)) { job.segmentTask = null; return; }
  job.segmentTask = basis || job.segmentTask || { invalid: true }; job.segmentInvalid = !basis;
  if (!basis) return;
  const first = STAGES.indexOf(basis.fromStage), last = STAGES.indexOf(basis.until), scope = STAGES.slice(first, last + 1);
  job.stages = { ...(job.stages || {}) };
  for (const stage of STAGES.slice(0, first)) job.stages[stage] = 'done';
  if (STAGES.indexOf(job.until) < first || STAGES.indexOf(job.until) > last) job.until = basis.until;
  const next = scope.find(stage => job.stages[stage] !== 'done') || null;
  if (interrupted) {
    job.status = 'failed'; job.stage = 'interrupted'; job.activeStage = null; job.attention = null;
    job.resumeStage = next; if (next) job.stages[next] = 'pending';
    job.error = '分段任务已中断；冻结材料与已有产物保留，请显式继续原范围。'; job.message = job.error;
  } else job.resumeStage = next;
}

function restoreMaterialScope(job, dir, interrupted = false) {
  const basis = materialBasisFor(dir);
  if (!basis && !isMaterialRecord(job, dir)) { job.materialReplenishment = null; return; }
  job.materialReplenishment = basis || job.materialReplenishment || { invalid: true };
  job.replenishmentInvalid = !basis;
  job.until = 'fulltext'; job.fulltextFailurePolicy = 'pause';
  job.materialAccessPolicy = job.materialAccessPolicy === 'defer' ? 'defer' : 'pause';
  job.stages = { ...(job.stages || {}), discover: 'done', dedupe: 'done' };
  job.resumeStage = job.status === 'completed' && job.stages.fulltext === 'done' ? null : 'fulltext';
  if (interrupted) {
    job.status = 'failed'; job.stage = 'interrupted'; job.activeStage = null;
    job.stages.fulltext = 'pending'; job.resumeStage = 'fulltext'; job.attention = null;
    job.error = '本地服务重启，材料补齐已暂停；请显式继续，仅补正文 PDF 和补充材料。';
    job.message = job.error;
  }
}

function executionOrder(config, queue) {
  return [...selectedSources(config).filter(source => !queue.includes(source)), ...queue];
}

function fulltextReviewEligible(job, dir) {
  if (!job || job.deletedAt || job.status === 'running' || job.child || job.browserOpening) return false;
  const status = loadJsonFile(path.join(dir, 'fulltext', 'status.json'));
  const dedupe = loadJsonFile(path.join(dir, 'dedupe', 'dedupe.json'));
  if (!Array.isArray(status?.items) || !Array.isArray(dedupe?.groups) || !dedupe.groups.length) return false;
  if (!(job.resumeStage === 'fulltext' || job.activeStage === 'fulltext' || job.stage === 'fulltext_review'
      || ['running', 'done', 'failed'].includes(job.stages?.fulltext))) return false;
  // A cache correction must never silently invalidate saved downstream work.
  for (const relative of ['extraction', 'validation', 'export']) {
    const directory = path.join(dir, relative);
    try { if (fs.readdirSync(directory).length) return false; } catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  return true;
}

const PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CNKI_RETRY_STATUSES = new Set(['pending', 'needs_attention', 'unavailable', 'abstract_only']);

function hasCnkiRetryScope(job) {
  return typeof job?.cnkiRetryPaperId === 'string' && PAPER_ID.test(job.cnkiRetryPaperId);
}

function restoreCnkiRetryScope(job, interrupted = false) {
  if (!hasCnkiRetryScope(job)) return;
  // Saved material completeness cannot promote a scoped single-paper action
  // into extraction. Only an explicit finished retry or offline review may
  // release this marker, including a crash after its result was persisted.
  job.resumeStage = 'fulltext'; job.until = 'fulltext'; job.activeStage = null;
  job.stages = { ...(job.stages || {}), fulltext: 'pending' };
  if (interrupted) {
    job.status = 'failed'; job.stage = 'interrupted'; job.attention = null;
    job.error = '本地服务已重启，单篇知网全文获取已暂停；已保存材料保留。';
    job.message = '单篇知网全文获取中断，范围仍限这一篇；若文件已保存请先复核全文，否则继续这篇知网文献，不会进入提取。';
  }
}

function cnkiRetryItems(job, dir) {
  if (!['needs_attention', 'failed', 'completed'].includes(job?.status) || !fulltextReviewEligible(job, dir)) return [];
  const report = loadJsonFile(path.join(dir, 'candidates.json'));
  const records = candidateRecords(report);
  const dedupe = loadJsonFile(path.join(dir, 'dedupe', 'dedupe.json'));
  const status = loadJsonFile(path.join(dir, 'fulltext', 'status.json'));
  if (!records || !Array.isArray(dedupe?.groups) || !Array.isArray(status?.items)) return [];
  const items = [], seen = new Set(), normalizeTitle = value => String(value || '').trim().replace(/\s+/g, ' ');
  for (const group of dedupe.groups) {
    const id = group?.canonical_id;
    if (typeof id !== 'string' || !PAPER_ID.test(id) || seen.has(id)
        || dedupe.groups.filter(other => other?.canonical_id === id).length !== 1) continue;
    seen.add(id);
    // Match exactly the canonical target chosen by fulltext.load_targets. Do
    // not convert another source's merged group into a CNKI download target.
    const members = Array.isArray(group.records) ? group.records.filter(record => record?.candidate_id === id) : [];
    const originals = records.filter(record => record.candidate_id === id);
    const states = status.items.filter(item => item?.paper_id === id);
    if (members.length !== 1 || originals.length !== 1 || states.length !== 1) continue;
    const member = members[0], original = originals[0], state = states[0];
    const materialsOnly = job.cnkiRetryPaperId === id && ['fetched_pdf', 'fetched_html'].includes(state.status)
      && pendingPaperMaterials(dir, id);
    const title = normalizeTitle(group.title || member.title);
    if (member.source_key !== 'cnki' || original.source_key !== 'cnki' || !title || title.length > 500
        || normalizeTitle(member.title) !== normalizeTitle(original.title) || title !== normalizeTitle(original.title)
        || (!CNKI_RETRY_STATUSES.has(state.status) && !materialsOnly) || normalizeTitle(state.title) !== title) continue;
    // Reasons are fixed UI explanations, never persisted URLs or session data.
    const reason = materialsOnly ? '主文已保存，本篇补充材料仍待处理；继续仅补充本篇材料，不重新下载正文'
      : state.status === 'abstract_only' ? '目前仅有摘要，尚未取得全文'
      : state.status === 'needs_attention' ? '原全文页面需要处理或核对'
        : state.status === 'pending' ? '尚未处理这篇文献' : '尚未取得可确认的全文，需要补充官方入口';
    items.push({ id, title, status: state.status, reason, ...(materialsOnly ? { materials_only: true } : {}) });
    if (items.length >= 100) break;
  }
  return items;
}

function pendingPaperMaterials(dir, paperId) {
  try {
    const inventory = readMaterials(dir);
    if (inventory.legacy) return false;
    const papers = inventory.papers.filter(paper => paper.paper_id === paperId);
    if (papers.length !== 1) return false;
    const paper = papers[0];
    return ['pending', 'needs_attention'].includes(paper.main_pdf_status)
      || !['checked', 'none_declared'].includes(paper.supplement_check.status)
      || paper.materials.some(material => material.role === 'supplement' && material.download_status !== 'downloaded');
  } catch (_) { return false; }
}

function existingPython(root, job) {
  const python = job.python || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('本地 Python 环境尚未准备；全文缓存复核不会联网安装依赖。');
  return python;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.job?.status === 'cancelled') { reject(new Error('检索已停止')); return; }
    const child = spawn(command, args, { cwd: options.cwd, env: { ...pythonEnv(), ...options.environment }, windowsHide: true });
    if (options.job) options.job.child = child;
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error('准备检索环境超时'));
    }, options.timeout || 180000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.job?.child === child) options.job.child = null;
      if (error) reject(error); else resolve(output.trim());
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-3000); });
    }
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(output.trim() || `命令退出码 ${code}`)));
  });
}

async function findPython(root) {
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const candidates = [process.env.WORKBENCH_PYTHON, ...(fs.existsSync(bundled) ? [bundled] : []), 'python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await runCommand(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3, 10)))'], { cwd: root, timeout: 5000 });
      if (result === '1') return candidate;
    } catch (_) { /* Try the next installed interpreter. */ }
  }
  throw new Error('未找到 Python 3.10+。请安装后重试，或设置 WORKBENCH_PYTHON 指向可用解释器。');
}

//: requirements-literature.txt 内容 sha256（LF 归一，§8.1）。
function requirementsHash(root) {
  const file = path.join(root, 'requirements-literature.txt');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

//: 读取 marker；仅接受 v2 JSON 结构，旧纯文本 marker 一律视为过期（§8.1）。
function readReadyMarker(marker) {
  const data = loadJsonFile(marker);
  if (data && typeof data === 'object' && data.schema === 2 && typeof data.requirementsSha256 === 'string') return data;
  return null;
}

async function preparePython(root, job, progress) {
  const venv = path.join(root, '.venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const marker = path.join(venv, '.literature-ready');
  const hash = requirementsHash(root);
  const ready = fs.existsSync(marker) ? readReadyMarker(marker) : null;
  if (fs.existsSync(python) && ready && ready.requirementsSha256 === hash) return python;
  progress('environment', '准备 Python 虚拟环境与 Chromium（首次运行可能较久）');
  if (!fs.existsSync(python)) {
    const base = await findPython(root);
    await runCommand(base, ['-m', 'venv', venv], { cwd: root, timeout: 120000, job });
  }
  // 依赖变更感知：requirements 变了（或 marker 缺省/旧格式）→ 重装；pip/playwright 超时 600s（裁决 D6）。
  await runCommand(python, ['-m', 'pip', 'install', '-r', path.join(root, 'requirements-literature.txt')], { cwd: root, timeout: 600000, job });
  await runCommand(python, ['-m', 'playwright', 'install', 'chromium'], { cwd: root, timeout: 600000, job });
  let version = '';
  try {
    version = await runCommand(python, ['-c', 'import sys; print(sys.version.split()[0])'], { cwd: root, timeout: 15000, job });
  } catch (_) { /* 版本串仅作记录，拿不到不阻断 */ }
  fs.writeFileSync(marker, JSON.stringify({ schema: 2, requirementsSha256: hash, createdAt: new Date().toISOString(), python: version }) + '\n');
  return python;
}

const pythonProcessSpecs = new Map();

async function stagePythonProcessSpec(root, python) {
  if (process.platform !== 'win32' || !path.isAbsolute(python) || !fs.existsSync(python)) return { executable: python, environment: {} };
  const key = path.resolve(python).toLowerCase();
  if (!pythonProcessSpecs.has(key)) {
    const pending = (async () => {
      // CPython's Windows venv redirector has a different PID from its script.
      // Probe only interpreter identity; never print these internal paths to UI.
      const raw = await runCommand(python, ['-c', 'import json,sys; print(json.dumps({"baseExecutable":getattr(sys,"_base_executable",sys.executable),"launcher":sys.executable}))'],
        { cwd: root, timeout: 5000 });
      let value;
      try { value = JSON.parse(raw); } catch (_) { throw new Error('无法确认 Python 阶段进程，请检查本机运行环境'); }
      if (![value?.baseExecutable, value?.launcher].every(name => typeof name === 'string' && path.isAbsolute(name)
          && !/[\r\n\0]/.test(name) && fs.existsSync(name))) throw new Error('无法确认 Python 阶段进程，请检查本机运行环境');
      return { executable: value.baseExecutable, environment: { __PYVENV_LAUNCHER__: value.launcher } };
    })();
    pythonProcessSpecs.set(key, pending);
    pending.catch(() => { if (pythonProcessSpecs.get(key) === pending) pythonProcessSpecs.delete(key); });
  }
  return pythonProcessSpecs.get(key);
}

//: 通用阶段执行器（§9.6）：spawn python -u <script> --config/--output-dir + stdout NDJSON。
//: discover 沿用既有 180s 文案；其余阶段用新超时文案（§8.3）。
async function runStageProcess(root, job, python, scriptName, extraArgs, onEvent) {
  const spec = await stagePythonProcessSpec(root, python);
  // A stop during the fixed interpreter probe must not launch a late stage.
  if (job.status !== 'running') throw new Error('任务已停止，阶段未启动');
  return new Promise((resolve, reject) => {
    const stage = job.activeStage || 'discover';
    const seconds = stageActivitySeconds(job, stage);
    const script = path.join(root, 'tools', scriptName);
    const configPath = path.join(job.dir, 'run_config.json');
    if (!fs.existsSync(configPath)) {
      const fallbackConfig = job.config || { topic: job.query || '', query: job.query || '', sources: ['google-scholar'], limit: job.limit || 10 };
      try { fs.writeFileSync(configPath, JSON.stringify(fallbackConfig, null, 2), 'utf8'); } catch (_) {}
    }
    const args = ['-u', script, '--config', configPath, '--output-dir', job.dir, ...(extraArgs || [])];
    const child = spawn(spec.executable, args, { cwd: root, env: { ...pythonEnv(), ...spec.environment }, windowsHide: true });
    job.child = child;
    let buffer = '';
    let stderr = '';
    let settled = false;
    let timer = null, terminal = false, lastProgress = '';
    function disarm() { if (timer !== null) clearTimeout(timer); timer = null; }
    function arm() {
      disarm();
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        const error = new Error(timeoutText(stage, seconds));
        error.code = 'LITERATURE_STAGE_TIMEOUT';
        finish(error);
      }, seconds * 1000);
    }
    arm();
    function finish(error) {
      if (settled) return;
      settled = true;
      disarm();
      if (job.child === child) job.child = null;
      if (error) reject(error); else resolve();
    }
    function consume(line) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        onEvent(event);
        if (stage === 'fulltext' && !settled && !terminal) {
          const activity = fulltextActivity(event);
          if (activity?.terminal) { terminal = true; disarm(); }
          else if (activity?.signature && activity.signature !== lastProgress) { lastProgress = activity.signature; arm(); }
        }
      } catch (_) { stderr = '检索脚本返回了无效状态'; }
    }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 100000) buffer = '';
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      consume(buffer);
      finish(code === 0 ? null : new Error(job.error || stderr || `检索脚本退出码 ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// 产物判定（§4.4；与 tools/literature-common.py detect_completed_stages 同表）
// ---------------------------------------------------------------------------

function extractionCoverage(jobDir) {
  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  let names = [];
  try { names = fs.readdirSync(inputsDir).filter(name => name.endsWith('.json')).sort(); } catch (_) { /* 未生成 */ }
  const coverage = { bundles: names.length, results: 0, pending: [], invalid: [] };
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    const payload = loadJsonFile(path.join(jobDir, 'extraction', `${stem}.json`));
    if (!payload) { coverage.pending.push(stem); continue; }
    const usable = payload.paper_id === stem && ['ok', 'partial', 'skipped'].includes(String(payload.status || '')) && Array.isArray(payload.rows);
    if (usable) coverage.results += 1; else coverage.invalid.push(stem);
  }
  return coverage;
}

function detectStagedArtifacts(jobDir) {
  const stages = {};
  const candidates = loadJsonFile(path.join(jobDir, 'candidates.json'));
  const config = loadJsonFile(path.join(jobDir, 'run_config.json'));
  stages.discover = materialBasisFor(jobDir) || processingBasisFor(jobDir, config) || (candidates && candidates.discovery_complete !== false && !checkpointDeferredSources(jobDir, config).length
    && Array.isArray(candidates.batches) && candidates.batches.length) ? 'done' : 'pending';

  const dedupe = loadJsonFile(path.join(jobDir, 'dedupe', 'dedupe.json'));
  stages.dedupe = dedupe && Number.isInteger(dedupe.version) && dedupe.version >= 1 && Array.isArray(dedupe.groups) ? 'done' : 'pending';

  const status = loadJsonFile(path.join(jobDir, 'fulltext', 'status.json'));
  const items = status && Array.isArray(status.items) ? status.items : null;
  stages.fulltext = items && items.length && items.every(item => item && String(item.status || '') !== 'pending') ? 'done' : 'pending';

  const coverage = extractionCoverage(jobDir);
  stages.extract = coverage.bundles && !coverage.pending.length && !coverage.invalid.length ? 'done' : 'pending';

  const validation = loadJsonFile(path.join(jobDir, 'validation', 'validation.json'));
  stages.validate = validation && typeof validation === 'object' && !Array.isArray(validation) ? 'done' : 'pending';

  stages.export = fs.existsSync(path.join(jobDir, 'export', 'literature.xlsx')) && fs.existsSync(path.join(jobDir, 'export', 'parameters.xlsx')) ? 'done' : 'pending';

  const resumeStage = STAGES.find(stage => stages[stage] !== 'done') || null;
  return { stages, resumeStage };
}

//: 扫描任务目录内符合交付物模式的文件（interrupted 恢复时重建可下载清单）。
function scanDeliverables(jobDir) {
  const found = [];
  const visit = (dir, prefix, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relative === 'export/history') continue;
        visit(path.join(dir, entry.name), relative, depth + 1);
      } else if (entry.isFile() && isDeliverable(relative)) {
        found.push(relative);
      }
    }
  };
  visit(jobDir, '', 0);
  const rest = found.filter(name => name !== 'run_config.json').sort();
  return found.includes('run_config.json') ? ['run_config.json', ...rest] : rest;
}

//: 有效 schema = confirmations.json 最新一条 kind=fieldDefinitions（§3.2）。
function readEffectiveSchema(jobDir) {
  const data = loadJsonFile(path.join(jobDir, 'confirmations.json'));
  const records = data && Array.isArray(data.records) ? data.records : [];
  let latest = null;
  for (const record of records) {
    if (record && record.kind === 'fieldDefinitions' && Array.isArray(record.fields)) latest = record;
  }
  return latest;
}

//: extract 阶段的缺省 Python 半（网页线由 server.js 注入 CodexBridge 适配器；此处为无 LLM 回退）。
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

//: bundle 的 field_definitions 与当前有效 schema 不一致 → 需 --force 重建（§2.4.4/§4.4）。
function staleBundles(jobDir, schemaFields) {
  const inputsDir = path.join(jobDir, 'extraction', 'inputs');
  let names = [];
  try { names = fs.readdirSync(inputsDir).filter(name => name.endsWith('.json')); } catch (_) { return []; }
  const current = JSON.stringify(canonicalJson(schemaFields));
  const stale = [];
  for (const name of names) {
    const bundle = loadJsonFile(path.join(inputsDir, name));
    if (!bundle || !Array.isArray(bundle.field_definitions)) continue;
    if (JSON.stringify(canonicalJson(bundle.field_definitions)) !== current) stale.push(name);
  }
  return stale;
}

async function defaultExtractStage(root, job, python, onEvent) {
  const schema = readEffectiveSchema(job.dir);
  if (!schema) {
    onEvent({ type: 'attention', stage: 'awaiting_confirmation', message: '提取前需由研究者确认主题参数字段含义与单位；确认后点击继续。' });
    return;
  }
  const stale = staleBundles(job.dir, schema.fields);
  await runStageProcess(root, job, python, STAGE_SCRIPTS.extract, stale.length ? ['--prepare', '--force'] : ['--prepare'], onEvent);
  if (job.status !== 'running') return;
  const coverage = extractionCoverage(job.dir);
  if (!coverage.bundles) {
    onEvent({ type: 'error', message: '未找到可提取的文献：请先完成 fulltext 阶段并确认 fulltext/status.json 有已获取全文项。' });
    return;
  }
  if (coverage.pending.length) {
    onEvent({
      type: 'attention', stage: 'extraction',
      message: `提取输入包已生成（${coverage.bundles} 篇）。请在网页端完成提取，或在 extraction/ 放置结果后重跑。`,
      counts: { bundles: coverage.bundles, results: coverage.results, pending: coverage.pending.length }
    });
    return;
  }
  await runStageProcess(root, job, python, STAGE_SCRIPTS.extract, ['--check'], onEvent);
}

class LiteratureConnector {
  constructor(root, options = {}) {
    this.root = root;
    this.base = path.join(root, '.workbench', 'literature');
    this.jobs = new Map();
    this.segmentPreparing = false;
    this.prepare = options.prepare || ((job, progress) => preparePython(root, job, progress));
    this.search = options.search || null;
    this.extract = options.extract || null;
    this.screen = options.screen || null;
    this.prepareOffline = options.prepareOffline || (async job => existingPython(this.root, job));
    this.segmentPreflight = options.segmentPreflight || (async (source, ids) => {
      const python = await this.prepareOffline({ dir: source.dir, config: source.config });
      const spec = await stagePythonProcessSpec(this.root, python);
      return segmentTasks.preflight(this.root, source, ids, spec);
    });
    this.openFulltext = options.openFulltext || (async (job, python) => {
      const spec = await stagePythonProcessSpec(this.root, python);
      if (job.status !== 'needs_attention' || job.resumeStage !== 'fulltext') throw new Error('任务状态已变化，请刷新后再操作');
      const raw = await runCommand(spec.executable, ['-u', path.join(this.root, 'tools', 'literature_fulltext.py'),
        '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir, '--open-current'],
      { cwd: this.root, timeout: 15000, environment: spec.environment }).catch(error => {
        for (const line of String(error.message || '').trim().split(/\r?\n/).reverse()) {
          let event;
          try { event = JSON.parse(line); } catch (_) { continue; }
          if (event?.type === 'error' && typeof event.message === 'string') throw new Error(event.message);
        }
        throw new Error('无法显示原任务下载窗口，请核对它是否仍然打开。');
      });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('全文任务页未返回有效状态，请重试'); }
      if (result?.opened !== true) throw new Error('全文任务页尚未打开，请先显式继续获取全文');
      return result;
    });
    this.openSource = options.openSource || (async (job, python, source) => {
      const raw = await runCommand(python, ['-u', path.join(this.root, 'tools', 'literature_browser.py'), '--open-source', source, '--output-dir', job.dir], { cwd: this.root, timeout: 45000 });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('检索浏览器未返回有效状态，请重试'); }
      if (!result || result.opened !== true || result.source !== source) throw new Error('无法打开对应检索页面，请检查本机浏览器环境');
      return result;
    });
    this.openDeferred = options.openDeferred || (async (job, python, paperId) => {
      const spec = await stagePythonProcessSpec(this.root, python);
      const raw = await runCommand(spec.executable, ['-u', path.join(this.root, 'tools', 'literature_fulltext.py'),
        '--config', path.join(job.dir, 'run_config.json'), '--output-dir', job.dir, '--open-deferred', paperId],
      { cwd: this.root, timeout: 15000, environment: spec.environment });
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new Error('原待处理页面未返回有效状态，请重试'); }
      if (result?.opened !== true || result.paper_id !== paperId) throw new Error('原待处理页面未打开，请保留登录窗口后重试');
      return result;
    });
  }

  public(job) {
    const queue = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
    const materialBasis = materialBasisFor(job.dir), materialsOnly = isMaterialRecord(job, job.dir);
    const segment = segmentBasisFor(job.dir), segmentOnly = isSegmentRecord(job, job.dir);
    const materialManualActions = materialsOnly ? materialReplenishment.manualActions(job.dir) : [];
    const materialSkippedActions = materialsOnly ? materialReplenishment.skippedActions(job.dir) : [];
    return { id: job.id, ...reviewLineage(job), status: job.status, stage: job.stage, message: job.message,
      discoveryProgress: checkpointDiscoveryProgress(job.dir, job.config) || safeDiscoveryProgress(job.discoveryProgress),
      count: job.count, config: job.config, files: availableCandidateFiles(job.dir, job.files), events: job.events, error: job.error,
      stages: job.stages, resumeStage: job.resumeStage, until: job.until, counters: job.counters, activeStage: job.activeStage || null,
      fulltextFailurePolicy: job.fulltextFailurePolicy === 'skip' ? 'skip' : 'pause',
      attention: sourceAttention(job.attention), deferredSources: queue, deferredOnly: checkpointDeferredOnly(job.dir, job.config),
      executionOrder: executionOrder(job.config, queue), processingBasis: job.processingBasis || null, deletedAt: job.deletedAt || null,
      materialReplenishment: materialBasis || job.materialReplenishment || (materialsOnly ? { invalid: true } : null),
      replenishmentInvalid: materialsOnly && !materialBasis,
      materialAccessPolicy: materialsOnly ? (job.materialAccessPolicy === 'defer' ? 'defer' : 'pause') : null,
      materialManualActions, materialManualCount: materialManualActions.length,
      materialSkippedActions, materialSkippedCount: materialSkippedActions.length,
      segmentTask: segment || job.segmentTask || (segmentOnly ? { invalid: true } : null), segmentInvalid: segmentOnly && !segment,
      canReplenishMaterials: !segmentOnly && materialReplenishment.eligible(this.root, job.id, job),
      canReviewFulltext: !segmentOnly && !materialsOnly && fulltextReviewEligible(job, job.dir),
      cnkiRetryItems: materialsOnly || segmentOnly ? [] : cnkiRetryItems(job, job.dir),
      cnkiRetryPaperId: typeof job.cnkiRetryPaperId === 'string' && PAPER_ID.test(job.cnkiRetryPaperId) ? job.cnkiRetryPaperId : null };
  }

  persist(job) {
    job.deferredSources = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(this.public(job), null, 2) + '\n');
  }

  update(job, stage, message) {
    if (job.status === 'cancelled' && stage !== 'cancelled') return;
    job.stage = stage;
    job.message = message;
    job.events.push({ at: new Date().toISOString(), stage, message });
    job.events = job.events.slice(-30);
    this.persist(job);
  }

  //: events.jsonl 全量审计流水（§4.2；网页路径唯一写入者 = 连接器）。
  appendEventLog(job, event) {
    try {
      const record = { at: new Date().toISOString(), type: String(event.type || ''), stage: String(event.stage || ''), message: String(event.message || '') };
      const extra = {};
      for (const [key, value] of Object.entries(event)) {
        if (!['type', 'stage', 'message'].includes(key)) extra[key] = value;
      }
      if (Object.keys(extra).length) record.extra = extra;
      fs.appendFileSync(path.join(job.dir, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    } catch (_) { /* 审计日志失败不影响任务本身 */ }
  }

  //: result.files → 模式校验 + 存在性校验通过才登记（§9.6/§21.2.5）。
  registerFiles(job, files) {
    for (const name of Array.isArray(files) ? files : []) {
      if (typeof name !== 'string' || !isDeliverable(name) || job.files.includes(name)) continue;
      const target = path.resolve(job.dir, name);
      if (!target.startsWith(job.dir + path.sep) || !fs.existsSync(target)) continue;
      job.files.push(name);
    }
  }

  //: fulltext 的 result.files 只含 status.json（I3 契约），正文文件按 items[].path 补登记。
  registerFulltextFiles(job) {
    const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
    const items = status && Array.isArray(status.items) ? status.items : [];
    this.registerFiles(job, items.map(item => item && item.path).filter(Boolean));
  }

  syncFulltextSnapshot(job) {
    const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
    if (!Array.isArray(status?.items)) return;
    const counts = Object.fromEntries(['fetched_pdf', 'fetched_html', 'partial', 'abstract_only', 'unavailable', 'needs_attention', 'pending'].map(key => [key, 0]));
    for (const item of status.items) if (item && Object.hasOwn(counts, item.status)) counts[item.status]++;
    counts.acquisition_skipped = status.items.filter(item => item?.acquisition_skip?.policy === 'skip_unavailable').length;
    if (Number.isInteger(status.counts?.material_incomplete)) counts.material_incomplete = status.counts.material_incomplete;
    for (const key of ['complete_main', 'materials_complete', 'materials_partial', 'materials_unverified', 'material_skipped']) {
      if (Number.isInteger(status.counts?.[key])) counts[key] = status.counts[key];
    }
    const count = counts.fetched_pdf + counts.fetched_html;
    job.count = count; this.mergeCounters(job, 'fulltext', { count, counts });
    this.registerFiles(job, ['fulltext/status.json']); this.registerFulltextFiles(job);
    this.registerFiles(job, ['manual-actions', 'skipped-materials'].flatMap(name => ['json', 'csv', 'md'].map(ext => 'fulltext/' + name + '.' + ext)));
  }

  mergeCounters(job, stage, event) {
    const counters = job.counters || (job.counters = {});
    const counts = event && typeof event.counts === 'object' && event.counts ? event.counts : {};
    const integer = value => (Number.isInteger(value) ? value : null);
    if (stage === 'discover' && integer(event.count) !== null) counters.candidates = event.count;
    if (stage === 'dedupe' && integer(counts.groups) !== null) counters.uniqueGroups = counts.groups;
    if (['fulltext', 'fulltext_review'].includes(stage) && (integer(event.count) !== null || integer(counts.fetched) !== null)) {
      counters.fulltextFetched = integer(event.count) !== null ? event.count : counts.fetched;
    }
    if (['fulltext', 'fulltext_review'].includes(stage)) {
      for (const [field, key] of Object.entries({ fetched_pdf: 'fulltextPdf', fetched_html: 'fulltextHtml',
        partial: 'fulltextPartial', complete_main: 'fulltextComplete',
        materials_complete: 'materialsComplete', materials_partial: 'materialsPartial', materials_unverified: 'materialsUnverified',
        abstract_only: 'fulltextAbstract', unavailable: 'fulltextUnavailable', needs_attention: 'fulltextAttention', pending: 'fulltextPending',
        acquisition_skipped: 'fulltextSkipped', material_incomplete: 'materialsIncomplete', material_skipped: 'materialsSkipped' })) {
        if (integer(counts[field]) !== null) counters[key] = counts[field];
      }
    }
    if (stage === 'extract' && integer(event.count) !== null) counters.extractedPapers = event.count;
    if (stage === 'validate' && integer(counts.parameters_total) !== null) counters.parameterRows = counts.parameters_total;
    if (stage === 'export' && integer(event.count) !== null) counters.parameterRows = event.count;
  }

  pauseEndDiscovery(job, message, attention = null) {
    this.registerFiles(job, scanDeliverables(job.dir));
    const candidates = loadJsonFile(path.join(job.dir, 'candidates.json'));
    const count = Number.isSafeInteger(candidates?.count) && candidates.count >= 0
      ? candidates.count : Array.isArray(candidates?.records) ? candidates.records.length : null;
    if (count !== null) { job.count = count; this.mergeCounters(job, 'discover', { count }); }
    job.status = 'needs_attention';
    job.error = null;
    job.resumeStage = 'discover';
    job.attention = sourceAttention(attention);
    if (job.stages) job.stages.discover = 'pending';
    const note = `${message} 已有分页结果保留，尚未确认末页；处理后点击“检查并继续”。`;
    this.appendEventLog(job, { type: 'attention', stage: 'interrupted', message: note });
    this.update(job, 'interrupted', note);
  }

  onStageEvent(job, runId, stageKey, event) {
    if (!event || typeof event !== 'object') return;
    this.appendEventLog(job, event);
    if (Number.isInteger(runId) && job.runId !== runId) return; // 旧一代 run：只审计不改状态
    if (job.status === 'cancelled') return;
    if (stageKey === 'discover' && event.discoveryProgress) {
      job.discoveryProgress = safeDiscoveryProgress(event.discoveryProgress);
    }
    if (stageKey === 'discover' && Object.hasOwn(event, 'deferred_sources')) {
      job.deferredSources = deferredSources(event.deferred_sources, job.config);
    }
    if (event.type === 'stage') {
      if (stageKey === 'discover') job.files = availableCandidateFiles(job.dir, job.files);
      if (stageKey === 'discover' && Number.isSafeInteger(event.count) && event.count >= 0) {
        job.count = event.count;
        this.mergeCounters(job, stageKey, event);
      }
      if (stageKey === 'fulltext' && event.counts) this.mergeCounters(job, stageKey, event);
      this.update(job, String(event.stage || stageKey), String(event.message || '正在处理'));
      return;
    }
    if (event.type === 'attention') {
      job.status = 'needs_attention';
      job.resumeStage = stageKey;
      if (job.stages && event.stage !== 'awaiting_confirmation') job.stages[stageKey] = 'pending';
      job.attention = sourceAttention(event);
      this.registerFiles(job, event.files);
      if (Number.isInteger(event.count)) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
      if (stageKey === 'fulltext') this.syncFulltextSnapshot(job);
      const label = String(event.stage || (stageKey === 'discover' ? 'verification' : stageKey));
      this.update(job, label, String(event.message || '需要人工处理'));
      return;
    }
    if (event.type === 'error') {
      if (stageKey === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
        this.registerFiles(job, event.files);
        if (Number.isSafeInteger(event.count) && event.count >= 0) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
        this.pauseEndDiscovery(job, String(event.message || '本页检索遇到问题，已暂停。'), { source: event.source, reason: 'results_unrecognized' });
        return;
      }
      job.status = 'failed';
      job.error = String(event.message || '检索失败');
      this.registerFiles(job, event.files);
      if (Number.isInteger(event.count)) { job.count = event.count; this.mergeCounters(job, stageKey, event); }
      if (job.stages) job.stages[stageKey] = 'failed';
      job.resumeStage = stageKey;
      this.update(job, 'failed', job.error);
      return;
    }
    if (event.type === 'result') {
      if (stageKey === 'discover') {
        const queue = checkpointDeferredSources(job.dir, job.config, job.deferredSources);
        const candidates = loadJsonFile(path.join(job.dir, 'candidates.json'));
        const trialComplete = isScholarTrial(job.config) && event.trial_complete === true
          && (job.discoveryProgress?.status === 'trial_complete' || checkpointDiscoveryProgress(job.dir, job.config)?.status === 'trial_complete');
        if (!trialComplete && (queue.length || event.discovery_complete === false || candidates?.discovery_complete === false)) {
          const state = loadJsonFile(path.join(job.dir, 'discovery-state.json'));
          this.onStageEvent(job, runId, stageKey, { type: 'attention', stage: 'verification',
            source: state?.pending_source || queue[0], reason: state?.pending_reason || 'results_unrecognized',
            message: '仍有暂缓或未完成来源，已有候选保留；请继续补检待处理来源后再进入去重。',
            count: event.count, files: event.files, deferred_sources: queue });
          return;
        }
      }
      job.count = Number.isInteger(event.count) ? event.count : 0;
      this.registerFiles(job, event.files);
      if (stageKey === 'fulltext') this.registerFulltextFiles(job);
      this.mergeCounters(job, stageKey, event);
      if (job.stages) job.stages[stageKey] = 'done';
      job.message = String(event.message || (stageKey === 'discover' ? `已保存 ${job.count} 条候选` : '阶段已完成'));
      this.persist(job);
    }
  }

  //: 通用阶段执行器（§9.6）：新阶段全部复用同一 NDJSON 协议。
  runStage(scriptName, extraArgs, job, onEvent) {
    return runStageProcess(this.root, job, job.python, scriptName, extraArgs, onEvent);
  }

  async runScreenedFulltextBatches(job, python, runId, bundles, controller) {
    const stopped = () => job.runId !== runId || job.status !== 'running' || controller.signal.aborted;
    const ids = bundles.map(bundle => bundle.paper_id), total = Math.ceil(ids.length / 10);
    let finalResult;
    for (let offset = 0; offset < ids.length; offset += 10) {
      if (stopped()) return;
      const paperIds = ids.slice(offset, offset + 10), batch = offset / 10 + 1;
      this.update(job, 'screening', `第 ${batch}/${total} 批：先核对 ${paperIds.length} 篇的摘要和篇关摘规则，再获取本批全文。`);
      const screened = await this.screen(job, python, event => {
        if (stopped()) return;
        if (event.type === 'result') {
          this.appendEventLog(job, event); this.registerFiles(job, event.files);
          job.counters.screening = event.counts; this.update(job, 'screening', event.message);
        } else this.onStageEvent(job, runId, 'fulltext', event);
      }, controller.signal, { paperIds });
      if (stopped()) return;
      if (screened?.ok !== true || JSON.stringify(screened.selectedPaperIds) !== JSON.stringify(paperIds)) {
        throw Object.assign(new Error('篇关摘批次未按所选文献完成，未开始本批下载。'), { code: 'SCREENING_ATTENTION', reason: 'screening_scope_invalid' });
      }
      let result;
      const args = ['--resume', '--screening-batch', '--only', paperIds.join(',')];
      if (job.fulltextFailurePolicy === 'skip') args.push('--skip-unavailable');
      // Only an explicitly selected skip policy permits unavailable material
      // to be skipped; advancing a batch never changes that policy.
      await this.runStage(STAGE_SCRIPTS.fulltext, args, job, event => {
        if (stopped()) return;
        if (event.type === 'result') {
          result = event;
          this.registerFiles(job, event.files); this.registerFulltextFiles(job);
          this.onStageEvent(job, runId, 'fulltext', { ...event, type: 'stage', stage: 'fulltext',
            message: `第 ${batch}/${total} 批全文处理已保存；其余文献继续按批处理。` });
        } else this.onStageEvent(job, runId, 'fulltext', event);
      });
      if (stopped()) return;
      if (!result || JSON.stringify(result.selected_paper_ids) !== JSON.stringify(paperIds)
          || (result.batch_complete !== true && result.quota_reached !== true)) {
        this.onStageEvent(job, runId, 'fulltext', { type: 'attention', stage: 'fulltext', reason: 'fulltext_batch_incomplete',
          message: '本批全文处理未明确结束；已完成项保留，请核查后继续。', files: ['fulltext/status.json'] });
        return;
      }
      finalResult = result;
      if (result.quota_reached === true) break;
    }
    if (stopped()) return;
    if (!finalResult || (finalResult.scope_complete !== true && finalResult.quota_reached !== true)) {
      this.onStageEvent(job, runId, 'fulltext', { type: 'attention', stage: 'fulltext', reason: 'fulltext_scope_incomplete',
        message: '仍有未筛或未处理文献，未标记全文阶段完成。', files: ['fulltext/status.json'] });
      return;
    }
    this.onStageEvent(job, runId, 'fulltext', { ...finalResult,
      completion_scope: finalResult.quota_reached ? 'configured_max_papers' : 'all_candidate_batches',
      message: finalResult.quota_reached ? '已达到本任务全文获取篇数上限，其余文献保持待处理。'
        : '所有候选批次已完成篇关摘与全文获取处理；缺失材料仍待补充，尚未开始提取。' });
  }

  async runSingleStage(job, python, stage, runId) {
    job.python = python;
    const onEvent = event => this.onStageEvent(job, runId, stage, event);
    const materialsOnly = isMaterialRecord(job, job.dir);
    if (isSegmentRecord(job, job.dir)) segmentTasks.assertStage(job.dir, stage);
    if (materialsOnly && (stage !== 'fulltext' || !materialBasisFor(job.dir))) throw new Error('材料补齐记录只能运行原候选的全文材料获取');
    if (stage === 'fulltext' && job.config.screeningPolicy && !materialsOnly) {
      const controller = new AbortController(); job.screeningAbort = controller;
      try {
        if (!this.screen) throw Object.assign(new Error('篇关摘筛选服务尚未连接，未开始下载。'), { code: 'SCREENING_ATTENTION', reason: 'screening_model_unavailable' });
        const bundles = require('./literature-screening').loadInputs(job.dir);
        if (bundles.length > 10) return await this.runScreenedFulltextBatches(job, python, runId, bundles, controller);
        const screened = await this.screen(job, python, event => {
          if (job.runId !== runId || job.status !== 'running') return;
          this.appendEventLog(job, event); this.registerFiles(job, event.files);
          if (event.type === 'result') {
            job.counters.screening = event.counts; this.update(job, 'screening', event.message);
          } else this.onStageEvent(job, runId, stage, event);
        }, controller.signal);
        if (job.runId !== runId || job.status !== 'running') return;
        if (screened?.ok !== true) throw Object.assign(new Error('篇关摘筛选未返回完成状态，未开始下载。'), { code: 'SCREENING_ATTENTION', reason: 'screening_output_invalid' });
      } catch (error) {
        if (error.code !== 'SCREENING_ATTENTION') throw error;
        if (job.status === 'running') this.onStageEvent(job, runId, stage, { type: 'attention', stage: 'screening', reason: error.reason, message: error.message, files: ['screening/status.json'] });
        return;
      } finally { job.screeningAbort = null; }
    }
    if (stage === 'discover' && this.search) {
      try { return await this.search(job, python, onEvent); }
      finally { job.deferSource = null; }
    }
    if (stage === 'extract' && this.extract) return this.extract(job, python, onEvent);
    if (stage === 'extract') return defaultExtractStage(this.root, job, python, onEvent);
    const extraArgs = [];
    if (materialsOnly) {
      extraArgs.push('--replenish-materials');
      if (job.materialAccessPolicy === 'defer') extraArgs.push('--defer-access');
      if (job.retryDeferred === true) extraArgs.push('--retry-deferred');
      if (job.retrySkipped === true) extraArgs.push('--retry-skipped');
      if (job.materialFirstPaperId) extraArgs.push('--first-paper', job.materialFirstPaperId);
    }
    if (stage === 'discover') {
      if (job.resumeCurrent) extraArgs.push('--scrape-current');
      if (job.resumeRun) extraArgs.push('--resume');
      if (job.deferSource) extraArgs.push('--defer-source', job.deferSource);
    } else if (job.resumeRun) {
      extraArgs.push('--resume');
    }
    if (stage === 'fulltext' && job.fulltextFailurePolicy === 'skip') extraArgs.push('--skip-unavailable');
    try { return await this.runStage(STAGE_SCRIPTS[stage], extraArgs, job, onEvent); }
    finally {
      if (stage === 'discover') job.deferSource = null;
      if (stage === 'fulltext') { job.retryDeferred = false; job.retrySkipped = false; job.materialFirstPaperId = null; }
    }
  }

  async run(job, fromStage = 'discover', until = 'discover') {
    assertScholarTrialScope(job.config, fromStage, until);
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再执行');
    if (isSegmentRecord(job, job.dir)) {
      const segment = segmentTasks.readBasis(job.dir, { verifyFiles: true });
      if (STAGES.indexOf(fromStage) < STAGES.indexOf(segment.fromStage) || STAGES.indexOf(until) > STAGES.indexOf(segment.until)
          || STAGES.indexOf(until) < STAGES.indexOf(fromStage)) throw new Error('执行阶段超出已确认的分段范围');
    }
    if (isMaterialRecord(job, job.dir)) {
      if (!materialBasisFor(job.dir)) throw new Error('材料补齐冻结输入无法核对，未开始运行');
      fromStage = 'fulltext'; until = 'fulltext'; job.until = 'fulltext'; job.resumeRun = true;
      job.fulltextFailurePolicy = 'pause';
    }
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1;
    job.runId = runId;
    job.activeStage = fromStage;
    job.resumeStage = null;
    try {
      if ((job.processingBasis || fs.existsSync(path.join(job.dir, 'processing-basis.json')))
          && !processingBasisFor(job.dir, job.config)) throw new Error('后续处理的冻结候选或执行依据无法核验，未继续运行');
      const python = await this.prepare(job, (stage, message) => this.update(job, stage, message));
      if (job.runId !== runId || job.status !== 'running') return;
      for (let index = STAGES.indexOf(fromStage); index <= STAGES.indexOf(until); index += 1) {
        const stage = STAGES[index];
        if (job.runId !== runId || job.status !== 'running') return;
        job.activeStage = stage;
        if (job.stages) job.stages[stage] = 'running';
        this.persist(job);
        await this.runSingleStage(job, python, stage, runId);
        if (job.runId !== runId) return; // 新一代 run 已接管（如 failed 后立即 advance）
        if (job.status === 'cancelled') return;
        if (job.status === 'needs_attention' || job.status === 'failed') {
          job.resumeStage = stage;
          this.persist(job);
          return;
        }
        if (job.stages && job.stages[stage] !== 'done') {
          if (stage === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
            this.pauseEndDiscovery(job, '检索进程未返回明确结束结果，已暂停。');
            return;
          }
          // 干净退出但无收尾事件 → 失败（§2.2）
          job.status = 'failed';
          job.stages[stage] = 'failed';
          job.resumeStage = stage;
          job.error = stage === 'discover' ? '检索脚本未返回结果' : '阶段脚本未返回结果';
          this.update(job, 'failed', job.error);
          return;
        }
        if (stage === 'fulltext' && index < STAGES.indexOf(until)) {
          job.status = 'needs_attention';
          job.resumeStage = 'extract';
          job.attention = null;
          this.update(job, 'fulltext_ready', '全文获取阶段已结束；请核对正文、摘要及待补充明细，确认提取字段后显式继续提取。');
          return;
        }
      }
      const next = STAGES.find(stage => job.stages[stage] !== 'done') || null;
      job.status = 'completed';
      job.activeStage = null;
      job.resumeStage = job.materialReplenishment ? null : next;
      if (isSegmentRecord(job, job.dir)) restoreSegmentScope(job, job.dir);
      this.update(job, 'completed', job.message || '阶段完成');
    } catch (error) {
      if (job.runId !== runId) return;
      if (job.status === 'cancelled') return;
      const stage = job.activeStage;
      if (stage === 'discover' && job.config?.searchMode === 'formal' && job.config.stopMode === 'end') {
        if (job.status === 'needs_attention') { this.persist(job); return; }
        const message = error.code === 'LITERATURE_STAGE_TIMEOUT'
          ? '本次检索达到单次运行时间保护，已暂停。'
          : '本地检索环境或进程遇到问题，已暂停；请检查网络和运行环境。';
        this.pauseEndDiscovery(job, message);
        return;
      }
      if (stage && job.stages && job.stages[stage] !== 'done') job.stages[stage] = 'failed';
      if (!job.resumeStage) job.resumeStage = stage || 'discover';
      if (job.status === 'failed' && job.error) { this.persist(job); return; }
      job.status = 'failed';
      job.error = error.message;
      this.update(job, 'failed', job.error);
    } finally {
      if (job.runId === runId && job.status === 'cancelled' && job.config?.researchPlan) {
        job.resumeStage ||= job.activeStage || fromStage;
        job.activeStage = null;
        this.persist(job);
      }
    }
  }

  start(rawConfig, resumeCurrent = false, until = null, reviewSnapshot = null, preparation = null) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    const config = normalizeConfig(rawConfig, { executable: true });
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.browserOpening)) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const boundary = until == null || until === '' ? 'discover' : String(until);
    if (!STAGES.includes(boundary)) throw new Error('阶段边界必须是 discover–export 的有效阶段名');
    assertScholarTrialScope(config, 'discover', boundary);
    if (reviewSnapshot && (reviewSnapshot.until !== boundary
      || JSON.stringify(normalizeConfig(reviewSnapshot.config)) !== JSON.stringify(config))) {
      throw new Error('核查快照与本次执行配置不一致，未开始检索');
    }
    const id = randomUUID(), lineage = reviewLineage(reviewSnapshot);
    const job = { id, ...lineage, dir: path.join(this.base, id), config, resumeCurrent: !lineage.parentJobId && resumeCurrent === true, status: 'running', stage: 'queued',
      message: '任务已排队', count: 0, files: ['run_config.json'], events: [], error: null, child: null,
      stages: Object.fromEntries(STAGES.map(stage => [stage, 'pending'])), resumeStage: null, until: boundary,
      counters: {}, limits: resolveLimits(config), activeStage: null, python: null, resumeRun: false, attention: null,
      deferredSources: [], deferSource: null };
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(path.join(job.dir, 'run_config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    if (reviewSnapshot) {
      fs.writeFileSync(path.join(job.dir, 'rule-review-confirmed.json'), JSON.stringify(reviewSnapshot, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
      job.files.push('rule-review-confirmed.json');
    }
    this.jobs.set(id, job);
    if (preparation?.basis) {
      fs.writeFileSync(path.join(job.dir, 'research-basis.json'), JSON.stringify(preparation.basis, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
      job.files.push('research-basis.json');
      job.status = 'needs_attention'; job.resumeStage = 'discover';
      this.update(job, 'prepared', '已载入已确认方案，尚未执行检索。选好本次阶段后点击“开始检索”，或导入该式导出的完整题录；遇到登录或验证时再按提示处理。');
      return this.public(job);
    }
    this.update(job, 'queued', '准备首批候选检索');
    void this.run(job, 'discover', boundary);
    return this.public(job);
  }

  continueAvailable(id, options = {}) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const until = options?.until;
    if (!STAGES.slice(1).includes(until)) throw new Error('后续处理阶段必须为 dedupe–export');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请等待或停止后重试');
    }
    const parentDir = path.join(this.base, id);
    const parent = this.jobs.get(id) || loadJsonFile(path.join(parentDir, 'job.json'));
    if (!parent) throw new Error('检索任务不存在');
    if (isScholarTrial(parent.config)) throw new Error('谷歌学术预试只获取候选，不能直接进入后续阶段');
    if (parent.deletedAt) throw new Error('该任务已删除，请先恢复后再处理');
    if (!['needs_attention', 'failed', 'cancelled'].includes(parent.status) || parent.resumeStage !== 'discover'
        || parent.child || parent.browserOpening) throw new Error('只能从已暂停的检索任务建立后续处理');
    let configBytes, candidateBytes, csvBytes, config, candidates;
    try {
      configBytes = fs.readFileSync(path.join(parentDir, 'run_config.json'));
      candidateBytes = fs.readFileSync(path.join(parentDir, 'candidates.json'));
      csvBytes = fs.readFileSync(path.join(parentDir, 'candidates.csv'));
      config = JSON.parse(configBytes.toString('utf8'));
      candidates = JSON.parse(candidateBytes.toString('utf8'));
    } catch (_) { throw new Error('已保存候选或冻结配置不完整，无法建立后续处理'); }
    if (!checkpointDeferredOnly(parentDir, config)) throw new Error('仍有未暂缓的待检索来源，请先处理或暂缓后再继续');
    const records = candidateRecords(candidates);
    if (!records?.length || (Object.hasOwn(candidates, 'count') && candidates.count !== records.length)) {
      throw new Error('没有可用的已保存候选，或候选数量与文件不一致');
    }
    const executionEvidence = frozenExecutionEvidence(parentDir, config);
    const basis = { parentJobId: id, candidateCount: records.length,
      deferredSources: checkpointDeferredSources(parentDir, config), candidateSnapshotSha256: sha256(candidateBytes),
      createdAt: new Date().toISOString() };
    const newId = randomUUID(), dir = path.join(this.base, newId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of [['run_config.json', configBytes], ['candidates.json', candidateBytes], ['candidates.csv', csvBytes]]) {
      fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
    }
    for (const [name, bytes] of executionEvidence) fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx', mode: 0o444 });
    fs.writeFileSync(path.join(dir, 'processing-basis.json'), JSON.stringify({ version: 1, ...basis,
      configSnapshotSha256: sha256(configBytes), candidateCsvSnapshotSha256: sha256(csvBytes),
      executionBasisSha256: Object.fromEntries([...executionEvidence].map(([name, bytes]) => [name, sha256(bytes)])) }, null, 2) + '\n', { flag: 'wx' });
    const job = { id: newId, dir, config, resumeCurrent: false, status: 'running', stage: 'queued',
      message: `基于现有 ${records.length} 条候选建立后续处理；部分来源仍待补检`, count: records.length,
      files: ['run_config.json', 'candidates.json', 'candidates.csv', 'processing-basis.json', ...executionEvidence.keys()], events: [], error: null, child: null,
      stages: Object.fromEntries(STAGES.map(stage => [stage, stage === 'discover' ? 'done' : 'pending'])),
      resumeStage: 'dedupe', until, counters: { candidates: records.length }, limits: resolveLimits(config),
      activeStage: null, python: null, resumeRun: false, attention: null, deferredSources: [], deferSource: null,
      processingBasis: basis };
    this.jobs.set(newId, job);
    this.update(job, 'queued', job.message);
    void this.run(job, 'dedupe', until);
    return this.public(job);
  }

  segmentPreview(id) {
    return segmentTasks.preview(segmentTasks.loadSource(this.root, id, this.jobs.get(id)));
  }

  async createSegmentTask(raw) {
    const data = segmentTasks.request(raw);
    for (const name of fs.readdirSync(this.base)) {
      if (!ID.test(name)) continue;
      const dir = path.join(this.base, name), saved = this.jobs.get(name) || loadJsonFile(path.join(dir, 'job.json'));
      const marker = loadJsonFile(path.join(dir, segmentTasks.MARKER));
      const link = marker?.requestId === data.requestId ? marker : saved?.segmentTask?.requestId === data.requestId ? saved.segmentTask : null;
      if (!link) continue;
      if (link.sourceJobId !== data.sourceJobId || link.fromStage !== data.fromStage || link.until !== data.until
          || JSON.stringify(link.paperIds) !== JSON.stringify(data.paperIds)) throw new Error('同一请求标识不能用于不同分段输入');
      if (!saved || saved.id !== name || saved.deletedAt) throw new Error('已有分段任务不完整或已删除，请先核对');
      segmentTasks.readBasis(dir);
      return this.snapshot(name);
    }
    if (this.segmentPreparing || [...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) throw new Error('文献任务正在处理，请稍后创建分段任务');
    this.segmentPreparing = true;
    try {
      const source = segmentTasks.loadSource(this.root, data.sourceJobId, this.jobs.get(data.sourceJobId));
      const initial = segmentTasks.plan(source, data);
      const checked = await this.segmentPreflight(source, data.paperIds);
      if (!Array.isArray(checked) || checked.length !== data.paperIds.length || new Set(checked.map(item => item?.paperId)).size !== checked.length) throw new Error('本地 PDF 预检范围无法核对');
      for (const id of data.paperIds) {
        const item = checked.find(item => item?.paperId === id);
        if (item?.allowed !== true) throw new Error(id + '：' + String(item?.reason || 'PDF 身份或可读性未通过本地核对'));
      }
      const fresh = segmentTasks.loadSource(this.root, data.sourceJobId, this.jobs.get(data.sourceJobId));
      const prepared = segmentTasks.plan(fresh, data);
      const signature = plan => JSON.stringify([...plan.files].map(([name, bytes]) => [name, sha256(bytes)]))
        + JSON.stringify([...plan.originals].map(([name, file]) => [name, file.sha256, file.size]));
      if (signature(initial) !== signature(prepared)) throw new Error('预检期间原材料或字段已变化，未创建分段任务');
      const id = randomUUID(), created = segmentTasks.create(this.root, id, prepared);
      const first = STAGES.indexOf(data.fromStage);
      const job = { id, dir: created.dir, config: prepared.config, status: 'needs_attention',
        stage: data.fromStage === 'extract' ? 'awaiting_confirmation' : 'awaiting_segment_confirmation',
        message: data.fromStage === 'extract' ? '所选材料已冻结；请在表头中讨论并确认字段，再显式开始提取。' : '已复用所选文献同版本的前序成果；请确认本次起止范围后执行。',
        count: data.fromStage === 'extract' ? data.paperIds.length : prepared.counters.parameterRows, files: [], events: [], error: null, child: null, activeStage: null, python: null,
        resumeStage: data.fromStage, until: data.until, resumeRun: true, resumeCurrent: false, attention: null,
        stages: Object.fromEntries(STAGES.map((stage, index) => [stage, index < first ? 'done' : 'pending'])),
        counters: prepared.counters,
        limits: resolveLimits(prepared.config), deferredSources: [], deferSource: null, segmentTask: created.basis };
      this.jobs.set(id, job);
      this.registerFiles(job, [...prepared.files.keys(), ...prepared.originals.keys(), segmentTasks.MARKER]);
      this.update(job, job.stage, job.message);
      return this.public(job);
    } finally { this.segmentPreparing = false; }
  }

  replenishMaterials(id) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    if (isSegmentRecord(this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json')), path.join(this.base, id))) throw new Error('分段任务只运行已选后续阶段；材料获取请回原任务');
    const snapshot = materialReplenishment.sourceSnapshot(this.root, id, this.jobs.get(id));
    // A repeated click returns its existing acquisition record without
    // resuming it or launching another browser/worker.
    for (const name of fs.readdirSync(this.base)) {
      if (!ID.test(name)) continue;
      const dir = path.join(this.base, name);
      const rawBasis = loadJsonFile(path.join(dir, materialReplenishment.MARKER));
      const saved = this.jobs.get(name) || loadJsonFile(path.join(dir, 'job.json'));
      const linked = [rawBasis, saved?.materialReplenishment].some(basis => basis?.parentJobId === id
        && (!basis.snapshotSha256 || basis.snapshotSha256 === snapshot.snapshotSha256));
      if (!linked) continue;
      const basis = materialReplenishment.readBasis(dir);
      if (!basis || !saved || saved.id !== name) throw new Error('已有材料补齐记录不完整，请先核对');
      if (saved.deletedAt) throw new Error('已有材料补齐记录已删除，请先恢复原补齐记录');
      return this.snapshot(name);
    }
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请等待或停止后补齐材料');
    }
    // A disk-only running record has not been proved idle. Do not start a
    // second acquisition browser merely because this process has no handle.
    for (const name of fs.readdirSync(this.base)) {
      if (ID.test(name) && loadJsonFile(path.join(this.base, name, 'job.json'))?.status === 'running') {
        throw new Error('仍有未核对的运行任务，请先在历史任务中处理后再补齐材料');
      }
    }
    const newId = randomUUID(), created = materialReplenishment.createSnapshot(this.root, newId, snapshot);
    const job = { id: newId, dir: created.dir, config: snapshot.config, resumeCurrent: false, status: 'running', stage: 'queued',
      message: `沿用原 ${snapshot.records.length} 条候选补齐正文 PDF 与补充材料；原提取和导出保留`,
      count: snapshot.records.length, files: [], events: [], error: null, child: null,
      stages: Object.fromEntries(STAGES.map(stage => [stage, ['discover', 'dedupe'].includes(stage) ? 'done' : 'pending'])),
      resumeStage: 'fulltext', until: 'fulltext', counters: { candidates: snapshot.records.length, uniqueGroups: snapshot.groupIds.length },
      limits: resolveLimits(snapshot.config), activeStage: null, python: null, resumeRun: true, fulltextFailurePolicy: 'pause',
      attention: null, deferredSources: [], deferSource: null, materialAccessPolicy: 'pause', materialReplenishment: materialBasisFor(created.dir) };
    this.jobs.set(newId, job);
    this.registerFiles(job, [...snapshot.files.map(file => file.name), 'fulltext/status.json',
      ...(snapshot.manifestFile ? ['fulltext/materials.json'] : []), ...snapshot.copies.map(file => file.name), materialReplenishment.MARKER]);
    this.syncFulltextSnapshot(job);
    this.update(job, 'queued', job.message);
    void this.run(job, 'fulltext', 'fulltext');
    return this.public(job);
  }

  reviewFulltext(id) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    if (isSegmentRecord(this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json')), path.join(this.base, id))) throw new Error('分段任务不能改写已冻结材料，请回原任务核查');
    if (isMaterialRecord(this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json')), path.join(this.base, id))) throw new Error('请在材料补齐记录中继续获取材料；复核不替代补齐');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请先停止或等待结束后复核');
    }
    const dir = path.join(this.base, id);
    let saved = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
    if (!saved) throw new Error('检索任务不存在');
    if (!this.jobs.has(id) && saved.status === 'running' && hasCnkiRetryScope(saved)) saved = this.loadPersisted(id);
    if (!fulltextReviewEligible(saved, dir)) throw new Error('只能复核已停止的全文任务；需有全文状态和去重输入，且尚未生成提取、校验或导出成果');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    job.status = 'running'; job.error = null; job.activeStage = 'fulltext'; job.resumeStage = 'fulltext';
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1; job.runId = runId;
    this.update(job, 'fulltext_review', '正在离线复核已保存全文；不重新检索或下载。');
    void this.runFulltextReview(job, runId);
    return this.public(job);
  }

  async runFulltextReview(job, runId) {
    let reviewed = false, reviewError = null;
    try {
      const python = await this.prepareOffline(job);
      if (job.runId !== runId || job.status !== 'running') return;
      job.python = python;
      await this.runStage(STAGE_SCRIPTS.fulltext, ['--review-only'], job, event => {
        if (!event || typeof event !== 'object') return;
        this.appendEventLog(job, event);
        if (job.runId !== runId || job.status === 'cancelled') return;
        if (event?.type === 'result' && event.stage === 'fulltext_review') {
          reviewed = true;
          this.registerFiles(job, event.files); this.registerFulltextFiles(job);
          if (Number.isInteger(event.count)) job.count = event.count;
          this.mergeCounters(job, 'fulltext_review', event);
        } else if (event.type === 'error') reviewError = String(event.message || '全文缓存复核失败');
      });
      if (job.runId !== runId || job.status === 'cancelled') return;
      if (reviewError) throw new Error(reviewError);
      if (!reviewed) throw new Error('全文缓存复核未返回有效结果');
      if (job.cnkiRetryPaperId) {
        const status = loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'));
        const item = status?.items?.find(item => item?.paper_id === job.cnkiRetryPaperId);
        // The researcher may stop just after the verified file and status were
        // saved but before the worker's result event. The offline review is the
        // gate that confirms that completed artifact and releases its scope.
        if (['fetched_pdf', 'fetched_html'].includes(item?.status) && !pendingPaperMaterials(job.dir, job.cnkiRetryPaperId)) job.cnkiRetryPaperId = null;
      }
      job.status = 'needs_attention'; job.resumeStage = 'fulltext'; job.activeStage = null; job.attention = null;
      job.stages = { ...(job.stages || {}), fulltext: 'pending' };
      this.update(job, 'fulltext_review', '缓存已复核，尚未继续获取全文。请核对复核报告，点击“继续获取全文”才会按原任务获取缺少材料；不会自动进入提取。');
    } catch (error) {
      if (job.runId !== runId || job.status === 'cancelled') return;
      job.status = 'failed'; job.resumeStage = 'fulltext'; job.activeStage = null; job.error = String(error.message || '全文缓存复核失败');
      this.update(job, 'fulltext_review', job.error);
    }
  }

  restartCnki(id, paperId) { return this.retryCnki(id, paperId, true); }

  retryCnki(id, paperId, restart = false) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    if (isSegmentRecord(this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json')), path.join(this.base, id))) throw new Error('分段任务不能下载或改写冻结材料');
    if (isMaterialRecord(this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json')), path.join(this.base, id))) throw new Error('材料补齐记录请使用普通继续，不能改为单篇下载范围');
    if (typeof paperId !== 'string' || !PAPER_ID.test(paperId)) throw new Error('无效的单篇文献标识');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) {
      throw new Error('已有文献任务正在运行，请先停止或等待结束后重试单篇');
    }
    const dir = path.join(this.base, id);
    let saved = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
    if (!saved) throw new Error('检索任务不存在');
    if (!this.jobs.has(id) && saved.status === 'running' && hasCnkiRetryScope(saved)) saved = this.loadPersisted(id);
    if (saved.status === 'cancelled') throw new Error('任务已停止，请先复核已保存全文，再重试指定文献');
    if (restart === true && (!['needs_attention', 'failed'].includes(saved.status) || saved.cnkiRetryPaperId !== paperId)) {
      throw new Error('只能重新定位当前已暂停的这篇知网文献，请先核对原单篇任务');
    }
    const target = cnkiRetryItems(saved, dir).find(item => item.id === paperId);
    if (!target) throw new Error('只能重试已暂停全文任务中尚未取得的知网单篇；请核对原候选、去重及全文状态，已有下游成果时不可重试');
    if (restart === true && target.materials_only) throw new Error('本篇正文已保存，请使用“继续这篇材料”，不能重新定位或下载正文');
    if (saved.cnkiRetryPaperId && saved.cnkiRetryPaperId !== paperId) throw new Error('上一篇知网全文尚未处理完成，请先继续原单篇任务');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    job.status = 'running'; job.error = null; job.attention = null; job.activeStage = 'fulltext'; job.resumeStage = 'fulltext';
    job.stages = { ...(job.stages || {}), fulltext: 'running' };
    job.cnkiRetryPaperId = paperId; job.until = 'fulltext';
    const runId = (Number.isInteger(job.runId) ? job.runId : 0) + 1; job.runId = runId;
    this.update(job, 'fulltext', (restart === true ? '仅重新定位这篇知网文献：' : '仅重试这篇知网文献：') + target.title + '；不重新检索候选或进入提取。');
    void this.runCnkiRetry(job, runId, paperId, restart === true);
    return this.public(job);
  }

  async runCnkiRetry(job, runId, paperId, restart = false) {
    let receivedResult = false;
    try {
      const python = await this.prepare(job, (stage, message) => this.update(job, stage, message));
      if (job.runId !== runId || job.status !== 'running') return;
      job.python = python;
      const args = ['--resume', '--only', paperId, '--retry-unavailable', '--limit', '1'];
      if (restart === true) args.push('--restart-cnki');
      await this.runStage(STAGE_SCRIPTS.fulltext, args, job, event => {
        if (job.runId !== runId || job.status === 'cancelled') return;
        if (event?.type === 'result' && event.stage === 'fulltext') receivedResult = true;
        this.onStageEvent(job, runId, 'fulltext', event);
      });
      if (job.runId !== runId || job.status === 'cancelled') return;
      if (['needs_attention', 'failed'].includes(job.status)) { this.persist(job); return; }
      if (!receivedResult) throw new Error('单篇全文获取未返回有效结果，已有材料保留');
      job.status = 'needs_attention'; job.resumeStage = 'fulltext'; job.attention = null;
      job.cnkiRetryPaperId = pendingPaperMaterials(job.dir, paperId) ? paperId : null;
      job.stages.fulltext = 'pending';
      this.update(job, 'fulltext_ready', '本篇已处理，请核查全文状态；其他材料仍待处理或补充。仅执行了指定的这一篇，不重新检索或进入提取。');
    } catch (error) {
      if (job.runId !== runId || job.status === 'cancelled') return;
      job.status = 'failed'; job.resumeStage = 'fulltext'; job.stages.fulltext = 'failed';
      job.error = String(error.message || '单篇知网全文重试失败');
      this.update(job, 'failed', job.error);
    } finally {
      if (job.runId === runId) { job.activeStage = null; this.persist(job); }
    }
  }

  //: 从磁盘装载历史任务（advance 续跑用）；interrupted（服务重启遗留 running）在此重写。
  loadPersisted(id) {
    const dir = path.join(this.base, id);
    const file = path.join(dir, 'job.json');
    if (!fs.existsSync(file)) throw new Error('检索任务不存在');
    const saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    const diskConfig = loadJsonFile(path.join(dir, 'run_config.json'));
    const config = saved.config || diskConfig || null;
    const job = {
      id, ...reviewLineage(saved), dir, config, resumeCurrent: false, status: saved.status, stage: saved.stage, message: saved.message,
      count: Number.isInteger(saved.count) ? saved.count : 0,
      files: Array.isArray(saved.files) ? saved.files.filter(isDeliverable) : ['run_config.json'],
      events: Array.isArray(saved.events) ? saved.events.slice(-30) : [],
      error: saved.error || null, child: null,
      stages: saved.stages && typeof saved.stages === 'object' ? saved.stages : null,
      resumeStage: typeof saved.resumeStage === 'string' && STAGES.includes(saved.resumeStage) ? saved.resumeStage : null,
      until: typeof saved.until === 'string' ? saved.until : null,
      fulltextFailurePolicy: saved.fulltextFailurePolicy === 'skip' ? 'skip' : 'pause',
      counters: saved.counters && typeof saved.counters === 'object' ? saved.counters : {},
      limits: resolveLimits(saved.config || diskConfig), activeStage: null, python: null, resumeRun: true,
      attention: sourceAttention(saved.attention), browserOpening: false,
      deferredSources: checkpointDeferredSources(dir, config), deferSource: null, deletedAt: saved.deletedAt || null,
      processingBasis: processingBasisFor(dir, config),
      materialReplenishment: saved.materialReplenishment || null, replenishmentInvalid: saved.replenishmentInvalid === true,
      materialAccessPolicy: saved.materialAccessPolicy === 'defer' ? 'defer' : 'pause', retryDeferred: false,
      segmentTask: saved.segmentTask || null, segmentInvalid: saved.segmentInvalid === true
    };
    job.cnkiRetryPaperId = typeof saved.cnkiRetryPaperId === 'string' && PAPER_ID.test(saved.cnkiRetryPaperId) ? saved.cnkiRetryPaperId : null;
    const detected = detectStagedArtifacts(dir);
    if (saved.status === 'running') {
      // 服务重启遗留 running → interrupted 改写（§4.3），按产物重建 stages/resumeStage 以便续跑。
      job.status = 'failed';
      job.stage = 'interrupted';
      job.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      job.files = scanDeliverables(dir);
      job.stages = detected.stages;
      job.resumeStage = detected.resumeStage;
      if (config?.searchMode === 'formal' && config.stopMode === 'end' && job.resumeStage === 'discover') {
        job.status = 'needs_attention';
        job.error = null;
        job.message = '本地服务已重启，检索已暂停；已有分页结果保留，尚未确认末页。请点击“检查并继续”恢复原任务。';
        job.attention = null;
      }
    } else {
      // 新格式（含 stages/resumeStage 字段）按登记值；缺失（旧任务）才按产物推导。
      if (!job.stages) job.stages = detected.stages;
      if (!Object.prototype.hasOwnProperty.call(saved, 'resumeStage')) job.resumeStage = detected.resumeStage;
    }
    restoreCnkiRetryScope(job, saved.status === 'running');
    restoreMaterialScope(job, dir, saved.status === 'running');
    restoreSegmentScope(job, dir, saved.status === 'running');
    this.jobs.set(id, job);
    return job;
  }

  //: POST /api/literature/advance（§21.2.2）：从 resumeStage 续跑，缺省 until=export。
  advance(id, options = {}) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    const requested = options && typeof options === 'object' ? options : {};
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const stored = this.jobs.get(id) || loadJsonFile(path.join(this.base, id, 'job.json'));
    if (stored?.deletedAt) throw new Error('该任务已删除，请先恢复后再执行');
    if (isScholarTrial(stored?.config)) {
      if (stored.status === 'completed') throw new Error('谷歌学术预试已结束；扩大范围须另建并核查新任务');
      if (options?.until && options.until !== 'discover') throw new Error('谷歌学术预试只能继续候选阶段（discover）');
    }
    const materialsOnly = isMaterialRecord(stored, path.join(this.base, id));
    const segmentOnly = isSegmentRecord(stored, path.join(this.base, id));
    const segment = segmentOnly ? segmentTasks.readBasis(path.join(this.base, id), { verifyFiles: true }) : null;
    if (!segment && Object.hasOwn(requested, 'confirmSegment')) throw new Error('仅分段任务可确认执行范围');
    if (segment) {
      const boundary = requested.until == null || requested.until === '' ? segment.until : requested.until;
      if (!segmentTasks.STAGES.includes(boundary) || STAGES.indexOf(boundary) < STAGES.indexOf(segment.fromStage)
          || STAGES.indexOf(boundary) > STAGES.indexOf(segment.until)) throw new Error('不能回退或越过已冻结的分段范围');
      if (['skipUnavailable', 'deferSource', 'deferAccess', 'retryDeferred', 'retrySkipped', 'firstPaperId'].some(key => Object.hasOwn(requested, key))) throw new Error('分段任务不能重新检索、下载或改写冻结材料');
      if (Object.hasOwn(requested, 'confirmSegment') && requested.confirmSegment !== true) throw new Error('请显式确认分段执行范围');
      if (segment.schemaLocked && requested.confirmations != null) throw new Error('复用提取或校验成果的字段版本已冻结，不能修改');
      if ((stored?.stage === 'awaiting_segment_confirmation' || (stored?.status === 'cancelled' && segment.schemaLocked)) && requested.confirmSegment !== true) throw new Error('请先确认分段执行范围；创建任务不会自动运行');
      if (segment.fromStage === 'extract' && !segmentTasks.fields(path.join(this.base, id)) && requested.confirmations == null) throw new Error('请先核对并确认本次字段表头，才会开始提取');
    }
    if (materialsOnly && !materialBasisFor(path.join(this.base, id))) throw new Error('材料补齐冻结输入无法核对，不能继续');
    const hasDeferAccess = Object.hasOwn(requested, 'deferAccess'), hasRetryDeferred = Object.hasOwn(requested, 'retryDeferred');
    const hasRetrySkipped = Object.hasOwn(requested, 'retrySkipped'), hasFirstPaper = Object.hasOwn(requested, 'firstPaperId');
    // A completed materials-only record may still contain explicitly skipped
    // gaps. Reopen only those recorded gaps, never a generic completed task.
    const completedSkippedPapers = new Set();
    if (materialsOnly && requested.retrySkipped === true && stored?.id === id
        && stored.status === 'completed' && stored.stages?.fulltext === 'done') {
      const entry = safeFile(path.join(this.base, id), 'fulltext/status.json');
      const progress = entry && entry.size <= 20 * 1024 * 1024 ? loadJsonFile(entry.file) : null;
      const items = Array.isArray(progress?.items) ? progress.items : [];
      for (const action of materialReplenishment.skippedActions(path.join(this.base, id))) {
        const item = items.find(value => value?.paper_id === action.paperId);
        if (item?.material_skipped?.reason === action.reason && (action.mainPdfMissing === true
            || action.supplements.missing.length || action.supplements.status !== 'complete'
            || !['checked', 'none_declared', 'none_found'].includes(action.supplements.checkStatus))) completedSkippedPapers.add(action.paperId);
      }
    }
    const retryCompletedMaterials = completedSkippedPapers.size > 0;
    if (hasDeferAccess || hasRetryDeferred || hasRetrySkipped || hasFirstPaper) {
      if (!materialsOnly) throw new Error('暂留登录与人工补齐清单仅用于材料补齐记录');
      if ((hasDeferAccess && requested.deferAccess !== true) || (hasRetryDeferred && requested.retryDeferred !== true)
          || (hasRetrySkipped && requested.retrySkipped !== true)) {
        throw new Error('材料暂留与显式重试必须为 true');
      }
      if (!retryCompletedMaterials && (!stored || !['needs_attention', 'failed', 'cancelled'].includes(stored.status) || stored.resumeStage !== 'fulltext')) {
        throw new Error('只能在材料补齐暂停后继续，范围保持全文获取');
      }
      if ((hasRetryDeferred || hasRetrySkipped || hasFirstPaper) && stored.materialAccessPolicy !== 'defer' && requested.deferAccess !== true) {
        throw new Error('请先启用暂留人工问题策略后再显式重试清单');
      }
      if (hasRetryDeferred && !materialReplenishment.manualActions(path.join(this.base, id)).length) {
        throw new Error('没有可重试的人工材料清单，请先继续处理其余文献');
      }
      if (hasRetrySkipped && !materialReplenishment.skippedActions(path.join(this.base, id)).length) {
        throw new Error('没有可显式重试的已跳过材料');
      }
      if (hasFirstPaper) {
        const status = loadJsonFile(path.join(this.base, id, 'fulltext', 'status.json'));
        const first = typeof requested.firstPaperId === 'string' && PAPER_ID.test(requested.firstPaperId)
          ? status?.items?.find(item => item?.paper_id === requested.firstPaperId) : null;
        if (!first) throw new Error('优先文献必须属于本材料补齐任务');
        if (retryCompletedMaterials && !completedSkippedPapers.has(requested.firstPaperId)) throw new Error('已完成材料记录只能优先重试尚未解决的已跳过材料');
        if ((first.material_deferred && !hasRetryDeferred) || (first.material_skipped && !hasRetrySkipped)) {
          throw new Error('优先文献仍在待处理或已跳过清单，请同时明确重试对应清单');
        }
      }
    }
    if (materialsOnly && ((requested.until && requested.until !== 'fulltext') || requested.confirmations != null
        || Object.hasOwn(requested, 'skipUnavailable') || requested.deferSource !== undefined)) {
      throw new Error('材料补齐只获取 PDF 和补充材料，不能检索、改字段、跳过验证或进入提取');
    }
    if (hasCnkiRetryScope(stored)) throw new Error('请使用“继续这篇知网文献”处理原单篇，不能扩大到其他文献');
    const hasSkip = Object.hasOwn(requested, 'skipUnavailable');
    if (hasSkip) {
      if (typeof requested.skipUnavailable !== 'boolean') throw new Error('跳过策略必须为布尔值');
      if (!stored || !['needs_attention', 'failed', 'cancelled'].includes(stored.status) || stored.resumeStage !== 'fulltext'
          || (stored.status === 'cancelled' && requested.skipUnavailable !== true)) {
        throw new Error('只能在全文获取暂停后调整跳过策略');
      }
      if (requested.deferSource !== undefined || requested.confirmations != null) throw new Error('跳过全文不能同时修改检索来源或提取字段');
      if (requested.until != null && requested.until !== '' && requested.until !== 'fulltext') throw new Error('跳过文献只继续全文获取，不进入提取');
    }
    let until = requested.until == null || requested.until === '' ? segment?.until || 'export' : String(requested.until);
    if (isScholarTrial(stored?.config)) until = 'discover';
    if (materialsOnly) until = 'fulltext';
    if (hasSkip) until = 'fulltext';
    if (!STAGES.includes(until)) throw new Error('阶段边界必须是 discover–export 的有效阶段名');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.browserOpening || ((retryCompletedMaterials || segmentOnly) && job.child))) throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const hasDefer = Object.hasOwn(requested, 'deferSource') && requested.deferSource !== undefined;
    if (hasDefer) {
      // Validate before loading/mutating a persisted job or appending any field
      // confirmations. Only Python changes the actual discovery checkpoint.
      const dir = path.join(this.base, id);
      const pending = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
      if (!pending) throw new Error('检索任务不存在');
      const config = pending.config || loadJsonFile(path.join(dir, 'run_config.json'));
      const attention = sourceAttention(pending.attention);
      const checkpoint = loadJsonFile(path.join(dir, 'discovery-state.json'));
      if (pending.status !== 'needs_attention' || pending.resumeStage !== 'discover') throw new Error('只能暂缓当前等待处理的检索来源');
      const originalUntil = pending.until || 'discover';
      if (!STAGES.includes(originalUntil)) throw new Error('原任务运行阶段无效，请先核对任务记录');
      if (requested.until != null && requested.until !== '' && String(requested.until) !== originalUntil) {
        throw new Error('暂缓来源只调整执行顺序，不能改变原任务的本次运行阶段');
      }
      until = originalUntil;
      if (typeof requested.deferSource !== 'string' || !selectedSources(config).includes(requested.deferSource)
          || requested.deferSource !== attention?.source || requested.deferSource !== checkpoint?.pending_source
          || checkpoint?.sources?.[requested.deferSource]?.status !== 'attention') {
        throw new Error('暂缓来源必须是原任务当前等待处理的已选来源');
      }
    }
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if ((job.processingBasis || fs.existsSync(path.join(job.dir, 'processing-basis.json')))
        && !processingBasisFor(job.dir, job.config)) throw new Error('后续处理的冻结候选或执行依据无法核验，未继续运行');
    if (materialsOnly) restoreMaterialScope(job, job.dir);
    if (segmentOnly) restoreSegmentScope(job, job.dir);
    if ((requested.until == null || requested.until === '') && job.status === 'needs_attention' && job.resumeStage === 'discover') until = job.until || 'discover';
    const resumeStoppedFulltext = job.status === 'cancelled' && (materialsOnly || (hasSkip && requested.skipUnavailable === true)) && job.resumeStage === 'fulltext';
    const resumeConfirmed = job.status === 'cancelled' && requested.resumeConfirmed === true
      && job.config?.researchPlan && job.config?.screeningPolicy
      && fs.existsSync(path.join(job.dir, 'research-basis.json')) && STAGES.includes(job.resumeStage)
      && !materialsOnly && !segmentOnly;
    const resumeStoppedSegment = job.status === 'cancelled' && segmentOnly && segmentTasks.STAGES.includes(job.resumeStage)
      && STAGES.indexOf(job.resumeStage) >= STAGES.indexOf(segment.fromStage) && STAGES.indexOf(job.resumeStage) <= STAGES.indexOf(segment.until);
    if (job.status === 'cancelled' && !resumeStoppedFulltext && !resumeStoppedSegment && !resumeConfirmed) throw new Error('任务已停止，不能继续；请发起新检索');
    if (resumeConfirmed && (job.child || job.screeningAbort || job.activeStage)) throw new Error('原任务正在保存停止状态，请稍后再继续');
    if (resumeStoppedSegment && job.child) throw new Error('原分段进程正在退出，请稍后再继续');
    if (resumeStoppedFulltext && (job.child || !Array.isArray(loadJsonFile(path.join(job.dir, 'fulltext', 'status.json'))?.items))) {
      throw new Error(job.child ? '原任务进程正在退出，请稍后再继续' : '原全文进度无法核对，请先核查历史任务');
    }
    if (job.status === 'running') throw new Error('已有文献检索正在运行，请等待或停止后重试');
    const stage = retryCompletedMaterials ? 'fulltext' : job.resumeStage || null;
    if (!stage) throw new Error('该任务已完成全部阶段');
    if (!['completed', 'needs_attention', 'failed'].includes(job.status) && !resumeStoppedFulltext && !resumeStoppedSegment && !resumeConfirmed) throw new Error('该任务已完成全部阶段');
    if (job.browserOpening) throw new Error('正在打开检索页面，请稍后继续');
    if (STAGES.indexOf(until) < STAGES.indexOf(stage)) throw new Error('请选择当前待运行阶段或之后的阶段');
    if (segmentOnly) segmentTasks.assertStage(job.dir, stage);
    if (requested.confirmations != null) this.appendConfirmations(job, requested.confirmations);
    if (hasSkip) job.fulltextFailurePolicy = requested.skipUnavailable ? 'skip' : 'pause';
    if (hasDeferAccess) job.materialAccessPolicy = 'defer';
    job.retryDeferred = hasRetryDeferred;
    job.retrySkipped = hasRetrySkipped;
    job.materialFirstPaperId = hasFirstPaper ? requested.firstPaperId : null;
    job.resumeRun = true;
    job.deferSource = hasDefer ? requested.deferSource : null;
    if (hasDefer) job.resumeCurrent = false;
    else if (stage === 'discover' && (job.attention || job.stage === 'verification' || job.stage === 'interrupted')) job.resumeCurrent = true;
    job.attention = null;
    job.status = 'running';
    job.error = null;
    job.until = until;
    this.update(job, stage, stage === 'fulltext' && job.fulltextFailurePolicy === 'skip'
      ? '继续获取全文：无法取得的正文或补充材料记录原因后跳过，保留已有成果。'
      : materialsOnly && job.materialAccessPolicy === 'defer'
        ? hasRetryDeferred ? '显式重试人工材料清单；仍需登录或权限的保留原页，继续其他文献。'
          : '继续补齐材料：登录、验证和权限问题暂留原页并记入清单，继续其他文献；人工等待不限时。'
      : `继续${STAGE_LABELS[stage] || stage}`);
    void this.run(job, stage, until);
    return this.public(job);
  }

  async openMaterialAction(id, paperId) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '') || !PAPER_ID.test(paperId || '')) throw new Error('无效文献任务或文献标识');
    const dir = path.join(this.base, id), saved = this.jobs.get(id) || loadJsonFile(path.join(dir, 'job.json'));
    if (!saved || saved.deletedAt) throw new Error(saved?.deletedAt ? '该任务已删除，请先恢复' : '文献任务不存在');
    if (!isMaterialRecord(saved, dir) || !materialBasisFor(dir)) throw new Error('仅能打开有效材料补齐记录的人工问题页');
    if (saved.status !== 'needs_attention' || saved.resumeStage !== 'fulltext') throw new Error('请等待本轮材料处理暂停后再打开人工问题页');
    if ([...this.jobs.values()].some(job => job.status === 'running' || job.child || job.browserOpening)) throw new Error('任务浏览器仍在使用，请稍后再打开');
    if (!materialReplenishment.manualActions(dir).some(item => item.paperId === paperId)) throw new Error('文献不在本任务待处理与待重查清单中');
    const browserFile = safeFile(dir, 'fulltext-browser.json');
    const browser = browserFile && browserFile.size <= 20 * 1024 * 1024 ? loadJsonFile(browserFile.file) : null;
    const deferred = browser?.deferred_papers?.[paperId];
    if (deferred?.paper_id !== paperId || typeof deferred.binding?.target_id !== 'string' || !deferred.binding.target_id) {
      throw new Error('该文献没有可恢复的原浏览器页面，请查看清单中的官方入口后再显式重试');
    }
    const job = this.jobs.get(id) || this.loadPersisted(id);
    job.browserOpening = true;
    try {
      const python = await this.prepareOffline(job);
      if (job.status !== 'needs_attention' || job.deletedAt) throw new Error('任务状态已变化，请刷新后再操作');
      const result = await this.openDeferred(job, python, paperId);
      if (result?.opened !== true || result.paper_id !== paperId) throw new Error('原待处理页面打开失败');
      return { opened: true, paperId, label: '原人工处理页面' };
    } finally { job.browserOpening = false; }
  }

  async openLogin(id) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再打开检索页面');
    if (job.status !== 'needs_attention' || !['discover', 'fulltext'].includes(job.resumeStage)) throw new Error('当前任务没有等待处理的检索或全文页面');
    if ([...this.jobs.values()].some(item => item.status === 'running' || item.browserOpening)) throw new Error('检索浏览器正在使用，请稍后再打开');
    const attention = sourceAttention(job.attention);
    const source = attention && job.config?.sources?.includes(attention.source) ? attention.source : null;
    const fulltext = job.resumeStage === 'fulltext';
    if (!fulltext && !source) throw new Error('缺少当前等待来源，请先继续任务以重新检查');
    job.browserOpening = true;
    try {
      const python = fulltext ? await this.prepareOffline(job) : job.python || await this.prepare(job, () => {});
      if (job.status !== 'needs_attention') throw new Error('任务状态已变化，请刷新后再操作');
      if (fulltext) {
        const result = await this.openFulltext(job, python);
        if (!result || result.opened !== true) throw new Error('全文任务页打开失败');
        return { opened: true, stage: 'fulltext', label: '原全文任务页' };
      }
      const result = await this.openSource(job, python, source);
      if (!result || result.opened !== true || result.source !== source) throw new Error('检索页面打开失败');
      return { opened: true, source, label: executableSources().find(item => item.key === source).label };
    } finally { job.browserOpening = false; }
  }

  //: 任务开始前主动打开官方登录/购买页；只接受白名单目标，不传任意 URL。
  async openAccessPage(target) {
    if (!ACCESS_TARGETS.includes(target)) throw new Error('只能打开白名单内的登录或购买页面');
    if ([...this.jobs.values()].some(item => item.status === 'running')) throw new Error('检索浏览器正在使用，请等任务暂停后再打开');
    const raw = await this.runAccessScript(['--open', target]);
    let result;
    try { result = JSON.parse(raw); } catch (_) { throw new Error('登录页未返回有效状态，请重试'); }
    if (!result || result.opened !== true || result.target !== target) {
      throw new Error(result?.message || '无法打开登录页，请检查本机检索浏览器');
    }
    return result;
  }

  //: 读取一个来源或全部来源的登录状态；不读凭据，仅返回显示名与判定。
  async accessStatus(source = 'wanfang') {
    if (!ACCESS_STATUS_SOURCES.includes(source)) throw new Error('只能读取白名单内的登录状态');
    const raw = await this.runAccessScript(['--status', source], source === 'all' ? 330000 : 60000);
    let result;
    try { result = JSON.parse(raw); } catch (_) { throw new Error('登录状态未返回有效结果，请重试'); }
    if (!result || result.checked !== true) throw new Error(result?.message || '登录状态未返回，请重试');
    return result;
  }

  async runAccessScript(args, timeout = 90000) {
    const python = path.join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(python)) throw new Error('本地 Python 环境尚未准备，请先运行一次文献任务');
    try {
      return await runCommand(python, ['-u', path.join(this.root, 'tools', 'literature_access.py'), ...args],
        { cwd: this.root, timeout });
    } catch (error) {
      const line = String(error.message || '').trim().split(/\r?\n/).pop();
      let parsed;
      try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
      throw new Error(parsed?.message || error.message || '登录页操作未完成');
    }
  }

  //: 追加确认记录（append-only，原子重写；§3.2）。
  appendConfirmations(job, confirmations) {
    const fields = confirmations && Array.isArray(confirmations.fields) ? confirmations.fields : null;
    const valid = fields && fields.length && fields.length <= MAX_FIELD_DEFINITIONS && fields.every(item =>
      item && typeof item === 'object' && !Array.isArray(item) && typeof item.key === 'string' && item.key.trim());
    if (!valid) throw new Error('字段确认内容无效');
    const file = path.join(job.dir, 'confirmations.json');
    const existing = loadJsonFile(file);
    const records = existing && Array.isArray(existing.records) ? existing.records : [];
    records.push({ at: new Date().toISOString(), by: 'researcher', kind: 'fieldDefinitions', fields, note: '' });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ records }, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
  }

  snapshot(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const live = this.jobs.get(id);
    if (live) return this.public(live);
    const dir = path.join(this.base, id);
    const file = path.join(dir, 'job.json');
    if (!fs.existsSync(file)) throw new Error('检索任务不存在');
    const saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    const frozenConfig = saved.config || loadJsonFile(path.join(dir, 'run_config.json'));
    saved.deletedAt = saved.deletedAt || null;
    saved.deferredSources = checkpointDeferredSources(dir, frozenConfig);
    saved.deferredOnly = checkpointDeferredOnly(dir, frozenConfig);
    saved.processingBasis = processingBasisFor(dir, frozenConfig);
    saved.executionOrder = executionOrder(frozenConfig, saved.deferredSources);
    const interrupted = saved.status === 'running';
    if (saved.status === 'running') {
      saved.status = 'failed'; saved.stage = 'interrupted';
      saved.error = '本地服务已重启，检索中断；已保存的文件仍可下载。';
      saved.files = scanDeliverables(dir);
      const detected = detectStagedArtifacts(dir);
      saved.stages = detected.stages;
      saved.resumeStage = detected.resumeStage;
      const config = saved.config || loadJsonFile(path.join(dir, 'run_config.json'));
      if (config?.searchMode === 'formal' && config.stopMode === 'end' && saved.resumeStage === 'discover') {
        saved.status = 'needs_attention';
        saved.error = null;
        saved.attention = null;
        saved.message = '本地服务已重启，检索已暂停；已有分页结果保留，尚未确认末页。请点击“检查并继续”恢复原任务。';
      }
    }
    restoreCnkiRetryScope(saved, interrupted);
    restoreMaterialScope(saved, dir, interrupted);
    restoreSegmentScope(saved, dir, interrupted);
    saved.materialManualActions = saved.materialReplenishment ? materialReplenishment.manualActions(dir) : [];
    saved.materialManualCount = saved.materialManualActions.length;
    saved.materialSkippedActions = saved.materialReplenishment ? materialReplenishment.skippedActions(dir) : [];
    saved.materialSkippedCount = saved.materialSkippedActions.length;
    saved.canReplenishMaterials = !saved.segmentTask && materialReplenishment.eligible(this.root, id, saved);
    saved.canReviewFulltext = !saved.segmentTask && !saved.materialReplenishment && fulltextReviewEligible(saved, dir);
    saved.cnkiRetryItems = saved.materialReplenishment || saved.segmentTask ? [] : cnkiRetryItems(saved, dir);
    saved.files = availableCandidateFiles(dir, saved.files);
    return saved;
  }

  //: GET /api/literature/jobs（§21.2.3）：按 job.json mtime 倒序，损坏记录跳过。
  list(limit, options = {}) {
    const size = Math.min(50, Math.max(1, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : 20));
    if (!fs.existsSync(this.base)) return [];
    const entries = [];
    for (const name of fs.readdirSync(this.base)) {
      if (!ID.test(name)) continue;
      const file = path.join(this.base, name, 'job.json');
      let stat;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      let saved = loadJsonFile(file);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      saved.deletedAt = saved.deletedAt || null;
      if (saved.deletedAt && options.includeDeleted !== true) continue;
      if (!this.jobs.has(name) && saved.status === 'running' && (hasCnkiRetryScope(saved)
          || isMaterialRecord(saved, path.join(this.base, name)) || isSegmentRecord(saved, path.join(this.base, name)))) saved = this.snapshot(name);
      const config = saved.config || loadJsonFile(path.join(this.base, name, 'run_config.json'));
      saved.deferredSources = checkpointDeferredSources(path.join(this.base, name), config);
      saved.deferredOnly = checkpointDeferredOnly(path.join(this.base, name), config);
      saved.processingBasis = processingBasisFor(path.join(this.base, name), config);
      restoreMaterialScope(saved, path.join(this.base, name));
      restoreSegmentScope(saved, path.join(this.base, name));
      saved.materialManualActions = saved.materialReplenishment ? materialReplenishment.manualActions(path.join(this.base, name)) : [];
      saved.materialManualCount = saved.materialManualActions.length;
      saved.materialSkippedActions = saved.materialReplenishment ? materialReplenishment.skippedActions(path.join(this.base, name)) : [];
      saved.materialSkippedCount = saved.materialSkippedActions.length;
      saved.canReplenishMaterials = !saved.segmentTask && materialReplenishment.eligible(this.root, name, saved);
      saved.executionOrder = executionOrder(config, saved.deferredSources);
      saved.canReviewFulltext = !saved.segmentTask && !saved.materialReplenishment && fulltextReviewEligible(saved, path.join(this.base, name));
      saved.cnkiRetryItems = saved.materialReplenishment || saved.segmentTask ? [] : cnkiRetryItems(saved, path.join(this.base, name));
      saved.files = availableCandidateFiles(path.join(this.base, name), saved.files);
      entries.push({ mtime: stat.mtimeMs, job: saved });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, size).map(entry => entry.job);
  }

  setDeleted(id, deleted) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const dir = path.join(this.base, id), file = path.join(dir, 'job.json');
    let saved = loadJsonFile(file);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('检索任务不存在');
    let live = this.jobs.get(id);
    if (live?.status === 'running' || live?.child || live?.browserOpening) {
      throw new Error('任务正在运行或打开检索页面，请先停止后再删除或恢复');
    }
    if (!live && saved.status === 'running') live = this.loadPersisted(id);
    if (live && saved.status === 'running' && live.status !== 'running') saved = { ...saved, ...this.public(live) };
    const deletedAt = deleted ? saved.deletedAt || new Date().toISOString() : null;
    if ((saved.deletedAt || null) !== deletedAt) {
      const temporary = path.join(dir, `job.json.tmp-${process.pid}-${Date.now()}`);
      try {
        fs.writeFileSync(temporary, JSON.stringify({ ...saved, deletedAt }, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch (_) {} }
      }
    }
    if (live) live.deletedAt = deletedAt;
    return this.snapshot(id);
  }

  deleteJob(id) { return this.setDeleted(id, true); }

  restoreJob(id) { return this.setDeleted(id, false); }

  materials(id) {
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const dir = path.join(this.base, id);
    if (!safeFile(dir, 'job.json')) throw new Error('检索任务不存在');
    return readMaterials(dir);
  }

  download(id, name) {
    const job = this.snapshot(id);
    if (typeof name === 'string' && name.startsWith('fulltext/materials/')) {
      const file = registeredMaterialFile(path.join(this.base, id), name);
      if (!file) throw new Error('材料未登记、尚未保存或路径不安全，不能下载');
      return file;
    }
    if (typeof name === 'string' && name.startsWith('fulltext/files/')) {
      const dir = path.join(this.base, id), file = registeredMaterialFile(dir, name);
      if (file) return file;
      if (safeFile(dir, 'fulltext/materials.json')) throw new Error('材料未在当前清单登记或尚未保存，不能下载');
    }
    if (!isDeliverable(name) || !Array.isArray(job.files) || !job.files.includes(name)) throw new Error('结果文件不存在');
    const dir = path.join(this.base, id);
    const entry = safeFile(dir, name);
    if (!entry) throw new Error('结果文件不存在或路径不安全');
    return entry.file;
  }

  cancel(id) {
    if (this.segmentPreparing) throw new Error('正在冻结分段材料，请稍后再操作');
    if (!ID.test(id || '')) throw new Error('无效检索任务标识');
    const job = this.jobs.get(id) || this.loadPersisted(id);
    if (job.deletedAt) throw new Error('该任务已删除，请先恢复后再操作');
    if (!job || !['running', 'needs_attention'].includes(job.status)) throw new Error('检索任务未在运行');
    job.status = 'cancelled';
    if (job.config?.researchPlan && STAGES.includes(job.activeStage)) job.resumeStage = job.activeStage;
    job.screeningAbort?.abort();
    if (job.child) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    if (isSegmentRecord(job, job.dir)) {
      restoreSegmentScope(job, job.dir);
      this.update(job, 'cancelled', '分段任务已停止；逐篇完成的成果保留，可在原范围内显式继续。');
      return this.public(job);
    }
    const discover = !job.activeStage || job.activeStage === 'discover';
    this.update(job, 'cancelled', discover ? '检索已停止；持久浏览器保持打开' : '任务已停止；已完成的阶段产物保留');
    return this.public(job);
  }
}

module.exports = { LiteratureConnector, STAGES, DELIVERABLE_PATTERNS, __internals: { preparePython, requirementsHash, detectStagedArtifacts, extractionCoverage, resolveLimits } };
