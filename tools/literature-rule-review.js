'use strict';

// Human confirmation is stored separately from AI assistance and from running jobs.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeConfig } = require('./literature-config');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGES = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];
const GROUPS = [
  { id: 'scope', title: '研究范围与条件', itemIds: ['topic', 'years', 'region-language', 'study-types'] },
  { id: 'search', title: '来源与检索式', itemIds: ['sources', 'query', 'source-queries'] },
  { id: 'delivery', title: '纳排与交付要求', itemIds: ['eligibility', 'fields', 'templates'] },
  { id: 'execution', title: '执行范围与边界', itemIds: ['search-mode', 'processing', 'timeouts', 'stage'] }
];
const ITEMS = [
  ['topic', 'scope', '研究主题', ['topic']],
  ['years', 'scope', '发表年份范围', ['publicationYearFrom', 'publicationYearTo']],
  ['region-language', 'scope', '地区与语言', ['geography', 'language']],
  ['study-types', 'scope', '研究与文献类型', ['studyTypes']],
  ['sources', 'search', '检索来源', ['sources']],
  ['query', 'search', '默认检索式', ['query']],
  ['source-queries', 'search', '各来源检索式', ['sourceQueries', 'scholarPlan']],
  ['eligibility', 'delivery', '纳入和排除规则', ['inclusion', 'exclusion']],
  ['fields', 'delivery', '提取字段与定义', ['targetFields', 'fieldDefinitions']],
  ['templates', 'delivery', '交付模板', ['templates']],
  ['search-mode', 'execution', '正式或测试模式、停止方式和批次', ['limit', 'searchMode', 'perSourceLimit', 'stopMode', 'batch']],
  ['processing', 'execution', '全文获取与提取设置', ['fulltext', 'extraction']],
  ['timeouts', 'execution', '各阶段超时边界', ['limits']],
  ['stage', 'execution', '本次执行到哪一步', ['version', 'until']]
].map(([id, groupId, title, keys]) => ({ id, groupId, title, keys }));
const CONFIG_KEYS = new Set(ITEMS.flatMap(item => item.keys).filter(key => key !== 'until'));
const ANNOTATION_KEYS = ['explanation', 'basis', 'impact', 'recommendation'];
const DEPENDENCIES = { sources: ['source-queries'], query: ['source-queries'], 'source-queries': ['search-mode'], 'search-mode': ['timeouts'], stage: ['processing'] };
const queues = new Map();
const MAX_REVIEW_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_BODY_BYTES = 8 * 1024 * 1024;

function error(message, code = 'INVALID_REVIEW_REQUEST', statusCode = 400) {
  const result = new Error(message); result.code = code; result.statusCode = statusCode; return result;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error(label + '必须是对象');
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw error(label + '包含不允许的字段：' + unknown.join('、'));
}
function json(value, label, maxBytes = 2 * 1024 * 1024) {
  const seen = new Set();
  function visit(entry) {
    if (entry === null || ['string', 'boolean'].includes(typeof entry)) return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || seen.has(entry)) throw error(label + '必须是有限、无循环的JSON值');
    if (!Array.isArray(entry)) object(entry, label);
    seen.add(entry); for (const child of Object.values(entry)) visit(child); seen.delete(entry);
  }
  visit(value);
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output, 'utf8') > maxBytes) throw error(label + '超过允许大小，未保存；请精简后重试');
  return JSON.parse(output);
}
function text(value, label, maxBytes = 64000) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) throw error(label + '必须是文本且不能超过大小限制');
  return value;
}
function id(value, label) { if (typeof value !== 'string' || !UUID.test(value)) throw error(label + '无效'); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) throw error('核查版本号无效'); return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function contextValue(raw) {
  if (raw == null) return { messages: [], approvedDoc: '' };
  keys(raw, ['messages', 'approvedDoc'], '核查依据');
  const value = json(raw, '核查依据（最多2MiB，未截断）', MAX_REVIEW_CONTEXT_BYTES);
  if (value.messages == null) value.messages = [];
  if (!Array.isArray(value.messages)) throw error('核查依据消息必须是列表');
  value.messages = value.messages.map(message => {
    keys(message, ['role', 'text'], '核查依据消息');
    if (!['user', 'assistant'].includes(message.role)) throw error('核查依据消息角色无效');
    return { role: message.role, text: text(message.text, '核查依据消息', MAX_REVIEW_CONTEXT_BYTES) };
  });
  value.approvedDoc = value.approvedDoc == null ? '' : text(value.approvedDoc, '已审核方案', MAX_REVIEW_CONTEXT_BYTES);
  return value;
}
function normalize(raw, until) {
  object(raw, '运行配置');
  const unknown = Object.keys(raw).filter(key => !CONFIG_KEYS.has(key));
  if (unknown.length) throw error('运行配置包含未归属核查项的字段：' + unknown.join('、'));
  json(raw, '运行配置');
  const config = normalizeConfig(raw);
  if (Object.keys(config).some(key => !CONFIG_KEYS.has(key))) throw error('配置结构已变化，请更新核查字段映射');
  if (!STAGES.includes(until)) throw error('执行阶段必须为 discover–export 的有效阶段');
  if (config.scholarPlan?.trialMaxPages != null && until !== 'discover') throw error('谷歌学术预试仅检索候选（discover），不能获取全文或提取参数');
  return { config, until };
}
function values(config, until) {
  const all = { ...config, until };
  return ITEMS.map(item => ({ ...clone(item), keys: itemKeys(item, all), value: Object.fromEntries(item.keys.filter(key => Object.hasOwn(all, key)).map(key => [key, clone(all[key])])) }));
}
function itemKeys(spec, value) { return spec.keys.filter(key => key !== 'scholarPlan' || Object.hasOwn(value || {}, key)); }
function annotationValue(raw) {
  keys(raw, ANNOTATION_KEYS, 'AI说明');
  return Object.fromEntries(ANNOTATION_KEYS.map(key => [key, raw[key] == null ? '' : text(raw[key], 'AI说明', 32000)]));
}
function refresh(review) {
  const confirmed = review.items.filter(item => item.status === 'confirmed').length;
  review.ready = confirmed === ITEMS.length;
  review.progress = { confirmed, total: ITEMS.length };
  review.config = Object.fromEntries(review.items.flatMap(item => Object.entries(item.value)).filter(([key]) => key !== 'until'));
  review.until = review.items.find(item => item.id === 'stage').value.until;
  return review;
}
function checkRevision(review, requested) {
  revision(requested);
  if (requested !== review.revision) throw error('核查内容已更新，请刷新后再操作；旧版本未覆盖当前记录', 'REVIEW_REVISION_CONFLICT', 409);
}
function itemFor(review, itemId) {
  const item = review.items.find(entry => entry.id === itemId);
  if (!item) throw error('核查项不存在'); return item;
}
function groupFor(review, groupId) {
  const group = review.groups.find(entry => entry.id === groupId);
  if (!group) throw error('核查组不存在'); return group;
}
function archive(item, action, at, extra = {}) {
  item.history.push({ at, action, version: item.version, status: item.status, value: clone(item.value), annotation: clone(item.annotation), ...extra });
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
async function locked(key, work) {
  const old = queues.get(key) || Promise.resolve();
  const running = old.catch(() => {}).then(work); queues.set(key, running);
  try { return await running; } finally { if (queues.get(key) === running) queues.delete(key); }
}

class LiteratureRuleReviewStore {
  constructor(root) { this.root = path.resolve(root); this.directory = path.join(this.root, '.workbench', 'literature-rule-reviews'); }
  async _directory(reviewId, create = false) {
    const parts = ['.workbench', 'literature-rule-reviews', id(reviewId, '核查标识')];
    let dir = this.root;
    for (const part of parts) {
      dir = path.join(dir, part);
      if (create) await fs.mkdir(dir, { recursive: false }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
      const stat = await fs.lstat(dir).catch(cause => { if (cause.code === 'ENOENT') throw error('核查记录不存在', 'REVIEW_NOT_FOUND', 404); throw cause; });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('核查记录目录不安全');
    }
    return dir;
  }
  async _read(reviewId, sessionId) {
    const expectedId = id(reviewId, '核查标识'), expectedSession = id(sessionId, '会话标识');
    const file = path.join(await this._directory(expectedId), 'review.json');
    const stat = await fs.lstat(file).catch(cause => { if (cause.code === 'ENOENT') throw error('核查记录不存在', 'REVIEW_NOT_FOUND', 404); throw cause; });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw error('核查记录文件不安全或过大');
    let review;
    try { review = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { throw error('核查记录无法读取；未覆盖原文件'); }
    if (review.id !== expectedId || review.sessionId !== expectedSession) throw error('核查记录不属于当前文献任务', 'REVIEW_SESSION_MISMATCH', 403);
    if (review.schemaVersion !== 1 || !Array.isArray(review.items) || review.items.length !== ITEMS.length || !Array.isArray(review.groups)) throw error('核查记录结构无效');
    for (const spec of ITEMS) {
      const found = review.items.filter(item => item.id === spec.id);
      if (found.length !== 1 || !equal(found[0].keys, itemKeys(spec, found[0].value)) || found[0].groupId !== spec.groupId || !['pending', 'confirmed'].includes(found[0].status) || !Number.isSafeInteger(found[0].version) || !Array.isArray(found[0].history)) throw error('核查项记录结构无效');
      const item = found[0]; keys(item.value, spec.keys, '核查项值');
    }
    if (!equal(review.groups, GROUPS)) throw error('核查分组记录无效');
    revision(review.revision); refresh(review);
    const checked = normalize(review.config, review.until);
    if (!equal(checked.config, review.config)) throw error('保存的核查配置与规范不一致，未自动改写');
    return review;
  }
  async _write(review) {
    const dir = await this._directory(review.id, true), file = path.join(dir, 'review.json');
    const temp = path.join(dir, '.review-' + crypto.randomUUID() + '.tmp');
    const bytes = JSON.stringify(refresh(review), null, 2) + '\n';
    if (Buffer.byteLength(bytes, 'utf8') > 32 * 1024 * 1024) throw error('核查历史达到大小限制，未覆盖原记录');
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, file);
    } catch (cause) { await fs.unlink(temp).catch(() => {}); throw cause; }
  }
  async create({ sessionId, workspaceId = '', config, until = 'discover', source = '', context } = {}) {
    sessionId = id(sessionId, '会话标识');
    workspaceId = text(workspaceId, '工作空间标识', 1000);
    const basis = normalize(config, until), now = new Date().toISOString();
    const review = {
      schemaVersion: 1, id: crypto.randomUUID(), sessionId, workspaceId, revision: 1,
      createdAt: now, updatedAt: now, currentGroupId: GROUPS[0].id,
      source: json(source, '规则来源', 160 * 1024), context: contextValue(context), sourceHistory: [], history: [],
      groups: clone(GROUPS), items: values(basis.config, basis.until).map(item => ({ ...item, status: 'pending', version: 1, history: [], annotation: annotationValue({}), discussion: [] }))
    };
    await this._write(review); return clone(refresh(review));
  }
  async _jobDirectory(jobId) {
    jobId = id(jobId, '原文献任务标识');
    let dir = this.root;
    for (const part of ['.workbench', 'literature', jobId]) {
      dir = path.join(dir, part);
      const stat = await fs.lstat(dir).catch(cause => { if (cause.code === 'ENOENT') throw error('原文献任务不存在', 'REVIEW_PARENT_NOT_FOUND', 404); throw cause; });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('原文献任务目录不安全');
    }
    return dir;
  }
  async _jobDocument(dir, name) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file).catch(cause => {
      if (cause.code === 'ENOENT') throw error(name === 'rule-review-confirmed.json' ? '原任务没有已确认的规则快照，不能继承核查；请重新整理并核查配置' : '原任务文件缺失：' + name, 'REVIEW_PARENT_SNAPSHOT_MISSING', 409);
      throw cause;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw error('原任务文件不安全或过大：' + name);
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { throw error('原任务文件无法解析：' + name); }
  }
  async _jobSnapshot(jobId, sessionId, workspaceId, live) {
    const dir = await this._jobDirectory(jobId), read = name => this._jobDocument(dir, name);
    const job = object(await read('job.json'), '原文献任务记录');
    if (job.id !== jobId || (live && live.id !== jobId)) throw error('原文献任务标识不一致');
    if (job.deletedAt || live?.deletedAt) throw error('原文献任务已删除，不能修改配置创建新核查', 'REVIEW_PARENT_DELETED', 409);
    if (!['completed', 'needs_attention', 'failed', 'cancelled'].includes(job.status)
        || (live && !['completed', 'needs_attention', 'failed', 'cancelled'].includes(live.status)) || live?.child || live?.browserOpening) {
      throw error('原文献任务仍在运行，请先暂停或停止后修改配置', 'REVIEW_PARENT_BUSY', 409);
    }
    const markers = await Promise.all(['segment-basis.json', 'materials-basis.json'].map(name => fs.lstat(path.join(dir, name)).then(() => true).catch(cause => { if (cause.code === 'ENOENT') return false; throw cause; })));
    if (job.segmentTask || job.segmentInvalid || job.materialReplenishment || job.replenishmentInvalid
        || live?.segmentTask || live?.segmentInvalid || live?.materialReplenishment || live?.replenishmentInvalid || markers.some(Boolean)) {
      throw error('请从原始文献检索任务修改配置；分段任务和材料补齐任务不能用于创建此核查', 'REVIEW_PARENT_NOT_ORDINARY', 409);
    }
    const snapshot = object(await read('rule-review-confirmed.json'), '原任务规则快照');
    if (snapshot.sessionId !== sessionId) throw error('原任务规则快照不属于当前文献会话', 'REVIEW_SESSION_MISMATCH', 403);
    if (snapshot.workspaceId !== workspaceId) throw error('原任务规则快照不属于当前工作空间', 'REVIEW_WORKSPACE_MISMATCH', 403);
    id(snapshot.reviewId, '原核查标识'); revision(snapshot.revision);
    const basis = normalize(snapshot.config, snapshot.until);
    if (!equal(basis.config, snapshot.config) || snapshot.fingerprint !== hash(basis)) throw error('原任务已确认规则快照的配置或校验值不一致', 'REVIEW_PARENT_SNAPSHOT_INVALID', 409);
    if (!Array.isArray(snapshot.items) || snapshot.items.length !== ITEMS.length) throw error('原任务核查快照缺少完整的14项确认', 'REVIEW_PARENT_SNAPSHOT_INVALID', 409);
    const expected = values(basis.config, basis.until);
    for (const spec of expected) {
      const matches = snapshot.items.filter(item => item?.id === spec.id), item = matches[0];
      if (matches.length !== 1 || item.status !== 'confirmed' || item.groupId !== spec.groupId || !equal(item.keys, itemKeys(spec, item.value))
          || !equal(item.value, spec.value) || !Number.isSafeInteger(item.version) || item.version < 1
          || !Array.isArray(item.history) || !Array.isArray(item.discussion)) {
        throw error('原任务核查项与已确认配置不一致：' + spec.title, 'REVIEW_PARENT_SNAPSHOT_INVALID', 409);
      }
      annotationValue(item.annotation);
    }
    const runConfig = await read('run_config.json');
    if (!equal(runConfig, snapshot.config) || !equal(job.config, snapshot.config)
        || (live?.config && !equal(live.config, snapshot.config))) throw error('原任务运行配置与已确认快照不一致，未创建新核查', 'REVIEW_PARENT_CONFIG_MISMATCH', 409);
    return { ...snapshot, source: json(snapshot.source, '原规则来源', 160 * 1024), context: contextValue(snapshot.context) };
  }
  async _historicalJobSnapshot(jobId, liveJob) {
    // Source ownership is resolved only from the server-held frozen job, never
    // from caller-supplied source session/workspace or a client snapshot.
    const ownership = object(await this._jobDocument(await this._jobDirectory(jobId), 'rule-review-confirmed.json'), '原任务规则快照');
    const sourceSessionId = id(ownership.sessionId, '原任务会话标识');
    const sourceWorkspaceId = text(ownership.workspaceId, '原任务工作空间标识', 1000);
    const snapshot = await this._jobSnapshot(jobId, sourceSessionId, sourceWorkspaceId, liveJob);
    const original = await this._read(snapshot.reviewId, sourceSessionId);
    if (original.workspaceId !== sourceWorkspaceId) throw error('原任务核查记录与冻结快照的工作空间不一致，未导入规则', 'REVIEW_PARENT_SNAPSHOT_INVALID', 409);
    return snapshot;
  }
  async fork(request, liveJob) {
    keys(request, ['jobId', 'sessionId', 'workspaceId', 'requestId', 'source', 'context', 'fromHistory'], '修改配置创建核查');
    if (Object.hasOwn(request, 'fromHistory') && typeof request.fromHistory !== 'boolean') throw error('历史导入标记必须为布尔值');
    if (request.fromHistory === true && (!Object.hasOwn(request, 'source') || !Object.hasOwn(request, 'context'))) throw error('历史导入必须提供当前讨论的规则来源和核查依据，不能省略后沿用旧依据');
    const jobId = id(request.jobId, '原文献任务标识'), sessionId = id(request.sessionId, '会话标识');
    const workspaceId = text(request.workspaceId, '工作空间标识', 1000);
    const requestId = request.requestId == null ? crypto.randomUUID() : id(request.requestId, '请求标识');
    // A stable request ID survives response loss/reload, but a new click can
    // deliberately create a later revision from the same immutable job.
    const digest = hash({ kind: 'rule-review-fork-v1', sessionId, requestId }).slice(0, 32);
    const reviewId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
    const requestFingerprint = hash(json(request, '修改配置创建核查请求'));
    return locked(path.join(this.directory, reviewId), async () => {
      const snapshot = request.fromHistory === true ? await this._historicalJobSnapshot(jobId, liveJob)
        : await this._jobSnapshot(jobId, sessionId, workspaceId, liveJob);
      let existing;
      try { existing = await this._read(reviewId, sessionId); } catch (cause) { if (cause.code !== 'REVIEW_NOT_FOUND') throw cause; }
      if (existing) {
        if (existing.forkRequestFingerprint !== requestFingerprint) throw error('同一请求标识对应的修改内容不同，请使用新的请求标识', 'REVIEW_FORK_REQUEST_CONFLICT', 409);
        return clone(existing);
      }
      const now = new Date().toISOString();
      const review = { schemaVersion: 1, id: reviewId, sessionId, workspaceId, revision: 1,
        createdAt: now, updatedAt: now, currentGroupId: GROUPS[0].id,
        parentJobId: jobId, parentReviewId: snapshot.reviewId, parentRevision: snapshot.revision,
        ...(request.fromHistory === true ? { sourceSessionId: snapshot.sessionId, sourceWorkspaceId: snapshot.workspaceId, sourceSnapshotFingerprint: snapshot.fingerprint } : {}),
        forkRequestId: requestId, forkRequestFingerprint: requestFingerprint,
        source: clone(snapshot.source), context: clone(snapshot.context), sourceHistory: [],
        history: [{ at: now, revision: 1, action: request.fromHistory === true ? 'import-history' : 'fork', parentJobId: jobId, parentReviewId: snapshot.reviewId, parentRevision: snapshot.revision,
          ...(request.fromHistory === true ? { sourceSessionId: snapshot.sessionId, sourceWorkspaceId: snapshot.workspaceId, sourceSnapshotFingerprint: snapshot.fingerprint } : {}) }],
        groups: clone(GROUPS), items: clone(snapshot.items) };
      const nextSource = Object.hasOwn(request, 'source') ? json(request.source, '规则来源', 160 * 1024) : review.source;
      const nextContext = Object.hasOwn(request, 'context') ? contextValue(request.context) : review.context;
      if (!equal(nextSource, review.source) || !equal(nextContext, review.context)) {
        review.sourceHistory.push({ at: now, revision: 1, source: clone(review.source), context: clone(review.context) });
        review.source = nextSource; review.context = nextContext;
        for (const item of review.items) {
          archive(item, 'sync', now, { reason: 'source-changed' }); item.version += 1; item.status = 'pending'; delete item.confirmedAt;
          item.annotation = annotationValue({});
        }
        review.revision = 2; review.history.push({ at: now, revision: 2, action: 'sync' });
      }
      await this._write(review); return clone(refresh(review));
    });
  }
  async get(reviewId, sessionId) { return clone(await this._read(reviewId, sessionId)); }
  async act(request) {
    keys(request, ['id', 'sessionId', 'revision', 'action', 'itemId', 'groupId', 'value', 'text', 'annotation', 'question', 'answer', 'config', 'until', 'source', 'context'], '核查操作');
    const reviewId = id(request.id, '核查标识'); id(request.sessionId, '会话标识');
    return locked(path.join(this.directory, reviewId), async () => {
      const review = await this._read(reviewId, request.sessionId); checkRevision(review, request.revision);
      const now = new Date().toISOString(), action = request.action;
      if (action === 'confirm') {
        const item = itemFor(review, request.itemId); archive(item, action, now); item.status = 'confirmed'; item.confirmedAt = now;
      } else if (action === 'group-confirm') {
        const group = groupFor(review, request.groupId);
        for (const itemId of group.itemIds) { const item = itemFor(review, itemId); archive(item, action, now); item.status = 'confirmed'; item.confirmedAt = now; }
      } else if (action === 'set-group') {
        groupFor(review, request.groupId); review.currentGroupId = request.groupId;
      } else if (action === 'edit' || action === 'sync') {
        let basis;
        if (action === 'edit') {
          const item = itemFor(review, request.itemId); keys(request.value, item.keys, '核查项修改值'); json(request.value, '核查项修改值');
          const all = { ...review.config, until: review.until };
          for (const key of item.keys) delete all[key];
          Object.assign(all, request.value);
          const { until, ...config } = all; basis = normalize(config, until);
        } else basis = normalize(request.config, request.until);
        const nextSource = Object.hasOwn(request, 'source') ? json(request.source, '规则来源', 160 * 1024) : review.source;
        const nextContext = Object.hasOwn(request, 'context') ? contextValue(request.context) : review.context;
        const sourceChanged = !equal(nextSource, review.source) || !equal(nextContext, review.context);
        if (sourceChanged) {
          review.sourceHistory.push({ at: now, revision: review.revision, source: clone(review.source), context: clone(review.context) });
          review.source = nextSource; review.context = nextContext;
        }
        const nextItems = values(basis.config, basis.until);
        const changedIds = nextItems.filter(next => !equal(itemFor(review, next.id).value, next.value)).map(next => next.id);
        const dependentIds = new Set(changedIds.flatMap(itemId => DEPENDENCIES[itemId] || []));
        for (const next of nextItems) {
          const item = itemFor(review, next.id), changed = !equal(item.value, next.value);
          if (!changed && !sourceChanged && !dependentIds.has(item.id)) continue;
          archive(item, action, now, { reason: sourceChanged ? 'source-changed' : changed ? 'value-changed' : 'dependency-changed' });
          item.value = next.value; item.keys = next.keys; item.version += 1; item.status = 'pending'; delete item.confirmedAt;
          item.annotation = annotationValue({});
        }
      } else if (action === 'annotation') {
        const item = itemFor(review, request.itemId); const annotation = annotationValue(request.annotation);
        archive(item, action, now); item.annotation = annotation;
      } else if (action === 'discussion') {
        const item = request.itemId ? itemFor(review, request.itemId) : null;
        const group = request.groupId ? groupFor(review, request.groupId) : null;
        if (!item && !group) throw error('讨论需要核查项或核查组');
        const entry = { at: now, question: text(request.question ?? request.text ?? '', '用户问题'), answer: text(request.answer ?? '', 'AI答复'), revision: review.revision };
        if (!entry.question.trim() && !entry.answer.trim()) throw error('讨论内容不能为空');
        for (const target of item ? [item] : group.itemIds.map(itemId => itemFor(review, itemId))) target.discussion.push(clone(entry));
      } else throw error('不支持的核查操作');
      review.revision += 1; review.updatedAt = now;
      review.history.push({ at: now, revision: review.revision, action, ...(request.itemId ? { itemId: request.itemId } : {}), ...(request.groupId ? { groupId: request.groupId } : {}) });
      await this._write(review); return clone(review);
    });
  }
  async applyAssist(request) {
    keys(request, ['id', 'sessionId', 'revision', 'annotations', 'question', 'answer', 'itemId', 'groupId'], 'AI核查辅助');
    const reviewId = id(request.id, '核查标识'); id(request.sessionId, '会话标识');
    if (!Array.isArray(request.annotations) || request.annotations.length > ITEMS.length) throw error('AI说明必须是核查项列表');
    const seen = new Set();
    const annotations = request.annotations.map(entry => {
      keys(entry, ['itemId', 'annotation'], 'AI核查项');
      if (!ITEMS.some(item => item.id === entry.itemId) || seen.has(entry.itemId)) throw error('AI返回未知或重复核查项');
      seen.add(entry.itemId); return { itemId: entry.itemId, annotation: annotationValue(entry.annotation) };
    });
    return locked(path.join(this.directory, reviewId), async () => {
      const review = await this._read(reviewId, request.sessionId); checkRevision(review, request.revision);
      const now = new Date().toISOString();
      if (request.groupId) groupFor(review, request.groupId);
      if (request.itemId) itemFor(review, request.itemId);
      if (request.itemId && annotations.some(entry => entry.itemId !== request.itemId)) throw error('AI说明超出请求核查项');
      if (request.groupId && annotations.some(entry => !groupFor(review, request.groupId).itemIds.includes(entry.itemId))) throw error('AI说明超出请求核查组');
      const hasDiscussion = Object.hasOwn(request, 'question') || Object.hasOwn(request, 'answer');
      let discussion;
      if (hasDiscussion) {
        if (!request.itemId && !request.groupId) throw error('AI问答需要核查项或核查组');
        discussion = { at: now, question: text(request.question ?? '', '用户问题'), answer: text(request.answer ?? '', 'AI答复'), revision: review.revision };
      }
      for (const entry of annotations) { const item = itemFor(review, entry.itemId); archive(item, 'assist', now); item.annotation = entry.annotation; }
      if (discussion) for (const item of request.itemId ? [itemFor(review, request.itemId)] : groupFor(review, request.groupId).itemIds.map(itemId => itemFor(review, itemId))) item.discussion.push(clone(discussion));
      review.revision += 1; review.updatedAt = now; review.history.push({ at: now, revision: review.revision, action: 'assist', itemIds: annotations.map(entry => entry.itemId) });
      await this._write(review); return clone(review);
    });
  }
  async snapshot({ id: reviewId, sessionId, revision: requested } = {}) {
    const review = await this._read(reviewId, sessionId); if (requested != null) checkRevision(review, requested);
    return frozen({ reviewId: review.id, revision: review.revision, sessionId: review.sessionId, workspaceId: review.workspaceId,
      createdAt: new Date().toISOString(), ready: review.ready, config: clone(review.config), until: review.until,
      source: clone(review.source), context: clone(review.context), items: clone(review.items), ...this._lineage(review), fingerprint: hash({ config: review.config, until: review.until }) });
  }
  _lineage(review) { return review.parentJobId ? { parentJobId: review.parentJobId, parentReviewId: review.parentReviewId, parentRevision: review.parentRevision,
    ...(review.sourceSessionId ? { sourceSessionId: review.sourceSessionId, sourceWorkspaceId: review.sourceWorkspaceId, sourceSnapshotFingerprint: review.sourceSnapshotFingerprint } : {}) } : {}; }
  async execution({ id: reviewId, sessionId, workspaceId, revision: requested, config, until } = {}) {
    const review = await this._read(reviewId, sessionId); checkRevision(review, requested);
    if (text(workspaceId, '工作空间标识', 1000) !== review.workspaceId) throw error('核查记录不属于当前工作空间', 'REVIEW_WORKSPACE_MISMATCH', 403);
    if (!review.ready) throw error('核查尚未全部确认，请先确认所有核查项', 'REVIEW_NOT_READY', 409);
    const basis = normalize(config, until);
    if (!equal(basis.config, review.config) || basis.until !== review.until) throw error('待运行配置或阶段与已确认内容不同，请重新同步并核查', 'REVIEW_CONFIG_MISMATCH', 409);
    const snapshot = { reviewId: review.id, revision: review.revision, sessionId: review.sessionId, workspaceId: review.workspaceId,
      confirmedAt: review.updatedAt, config: clone(review.config), until: review.until, source: clone(review.source), context: clone(review.context),
      items: clone(review.items), ...this._lineage(review), fingerprint: hash({ config: review.config, until: review.until }) };
    return frozen({ id: review.id, reviewId: review.id, revision: review.revision, config: clone(review.config), until: review.until, snapshot });
  }
}

module.exports = { LiteratureRuleReviewStore, GROUPS, ITEMS, STAGES, MAX_REVIEW_CONTEXT_BYTES, MAX_REVIEW_BODY_BYTES };
