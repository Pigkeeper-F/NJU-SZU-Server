'use strict';

// Local, append-only discussion backups. These records are evidence/drafts,
// never an execution config, human confirmation, credential or task binding.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_DISCUSSION_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20000;
const STAGES = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];
const CONFIG_KEYS = ['version', 'topic', 'query', 'sources', 'publicationYearFrom', 'publicationYearTo', 'geography', 'language',
  'studyTypes', 'inclusion', 'exclusion', 'targetFields', 'limit', 'sourceQueries', 'searchMode', 'perSourceLimit', 'stopMode',
  'batch', 'fieldDefinitions', 'templates', 'fulltext', 'extraction', 'limits',
  // Scientific rule text, plan provenance and Scholar batches are draft data.
  // Keep the recursive credential/path guard; backing these up grants no run.
  'screeningPolicy', 'researchPlan', 'scholarPlan'];
const FORBIDDEN_KEYS = /^(?:__proto__|constructor|prototype|api[-_]?keys?|access[-_]?token|refresh[-_]?token|id[-_]?token|token|authorization|cookie|password|credentials?|secrets?|env|settings|headers|cwd|filePath|outputDir|writableRoots)$/i;
const VERSION = /^([0-9]{12})$/;
const queues = new Map();
function fail(message, code = 'INVALID_DISCUSSION_REQUEST', statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(label + '必须是普通对象');
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail(label + '包含不允许的字段；存档不接收凭据或文件操作参数');
}
function text(value, label, max = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string' || value.length > max) throw fail(label + '必须为文本且不超过' + max + '字；未截断内容');
  return value;
}
function identifier(value, label) {
  text(value, label, 512);
  if (!value.trim() || value !== value.trim() || /[\\/\x00-\x1f]/.test(value)) throw fail(label + '无效');
  return value;
}
function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  text(value, label, 128);
  if (!Number.isFinite(Date.parse(value))) throw fail(label + '必须是有效时间');
  return value;
}
function jsonValue(value, label, depth = 0, seen = new Set()) {
  if (depth > 40) throw fail(label + '结构过深；未保存');
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw fail(label + '必须是有限、无循环的JSON值');
  if (!Array.isArray(value)) object(value, label);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw fail(label + '包含凭据或文件操作字段，不能存入讨论存档');
    jsonValue(child, label, depth + 1, seen);
  }
  seen.delete(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function scopeValue(raw, workspace = true) {
  return { projectId: identifier(raw.projectId, '项目标识'), moduleId: identifier(raw.moduleId, '模块标识'),
    ...(workspace ? { workspaceId: identifier(raw.workspaceId, '文献工作区标识') } : {}) };
}
function snapshotValue(raw) {
  keys(raw, ['messages', 'composer', 'docDraftText', 'docEditing', 'config', 'until', 'approvedDoc', 'rules'], '讨论快照');
  if (!Array.isArray(raw.messages)) throw fail('讨论消息必须是完整列表');
  const seen = new Set();
  const messages = raw.messages.map((entry, index) => {
    keys(entry, ['id', 'role', 'text', 'at'], '第' + (index + 1) + '条消息');
    const id = identifier(entry.id, '消息标识');
    if (seen.has(id)) throw fail('讨论中存在重复消息标识；未删除或合并消息');
    seen.add(id);
    if (!['user', 'assistant', 'system'].includes(entry.role)) throw fail('讨论消息角色无效');
    return { id, role: entry.role, text: text(entry.text, '消息正文'), at: timestamp(entry.at, '消息时间') };
  });
  const config = raw.config == null ? null : raw.config;
  if (config !== null) { keys(config, CONFIG_KEYS, '科学配置草稿'); jsonValue(config, '科学配置草稿'); }
  const until = raw.until == null ? 'discover' : raw.until;
  if (!STAGES.includes(until)) throw fail('讨论快照的阶段无效');
  if (raw.docEditing != null && typeof raw.docEditing !== 'boolean') throw fail('文档编辑状态必须是布尔值');
  let approvedDoc = raw.approvedDoc ?? null;
  if (approvedDoc !== null) {
    keys(approvedDoc, ['content', 'status', 'updatedAt', 'approvedAt'], '文档备份');
    if (!['draft', 'approved'].includes(approvedDoc.status)) throw fail('文档备份状态无效');
    approvedDoc = { content: text(approvedDoc.content, '文档正文'), status: approvedDoc.status,
      updatedAt: timestamp(approvedDoc.updatedAt, '文档更新时间'), approvedAt: timestamp(approvedDoc.approvedAt ?? null, '文档原审核时间', true) };
  }
  let rules = raw.rules ?? null;
  if (rules !== null) {
    keys(rules, ['draft', 'confirmed', 'versions'], '规则备份');
    if (!Array.isArray(rules.versions)) throw fail('规则历史必须为列表');
    rules = { draft: text(rules.draft ?? '', '规则草稿'), confirmed: text(rules.confirmed ?? '', '原规则文本'), versions: rules.versions.map(entry => {
      keys(entry, ['text', 'at'], '规则历史'); return { text: text(entry.text, '历史规则正文'), at: timestamp(entry.at, '历史规则时间') };
    }) };
  }
  return { messages, composer: text(raw.composer ?? '', '输入框草稿'), docDraftText: text(raw.docDraftText ?? '', '编辑中文档草稿'),
    docEditing: raw.docEditing ?? false, config: clone(config), until, approvedDoc, rules };
}
function description(snapshot) {
  const roles = snapshot.messages.map(message => message.role);
  return { messageCount: roles.length, userMessageCount: roles.filter(role => role === 'user').length,
    assistantMessageCount: roles.filter(role => role === 'assistant').length, systemMessageCount: roles.filter(role => role === 'system').length,
    hasDraft: !!(snapshot.composer || snapshot.docDraftText || snapshot.docEditing || snapshot.config !== null || snapshot.rules?.draft),
    hasApprovedDoc: snapshot.approvedDoc?.status === 'approved', hasRules: !!(snapshot.rules && (snapshot.rules.draft || snapshot.rules.confirmed || snapshot.rules.versions.length)) };
}
async function locked(key, operation) {
  const previous = queues.get(key) || Promise.resolve(), running = previous.catch(() => {}).then(operation);
  queues.set(key, running);
  try { return await running; } finally { if (queues.get(key) === running) queues.delete(key); }
}

class LiteratureDiscussionStore {
  constructor(root) { this.root = path.resolve(root); this.directory = path.join(this.root, '.workbench', 'literature-discussions'); }
  async _directory(scope, workspace = true, create = false) {
    const parts = ['.workbench', 'literature-discussions', hash([scope.projectId, scope.moduleId])];
    if (workspace) parts.push(hash([scope.projectId, scope.moduleId, scope.workspaceId]));
    let directory = this.root;
    for (const part of parts) {
      directory = path.join(directory, part);
      if (create) await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') throw fail('讨论存档不存在', 'DISCUSSION_NOT_FOUND', 404); throw error; });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('讨论存档目录不安全', 'DISCUSSION_UNSAFE_PATH');
    }
    return directory;
  }
  async _json(dir, name) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') throw fail('讨论版本文件缺失；旧版本保留', 'DISCUSSION_CORRUPT', 409); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DISCUSSION_BYTES) throw fail('讨论版本文件不安全或过大', 'DISCUSSION_UNSAFE_PATH');
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { throw fail('讨论版本无法解析；旧文件未覆盖', 'DISCUSSION_CORRUPT', 409); }
  }
  async _versions(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const versions = [];
    for (const entry of entries) {
      if (!VERSION.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('讨论版本目录不安全', 'DISCUSSION_UNSAFE_PATH');
      versions.push(Number(entry.name));
    }
    return versions.sort((a, b) => a - b);
  }
  async _meta(dir, scope, revision) {
    const versionDir = path.join(dir, String(revision).padStart(12, '0'));
    const stat = await fs.lstat(versionDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('讨论版本目录不安全', 'DISCUSSION_UNSAFE_PATH');
    const meta = await this._json(versionDir, 'metadata.json');
    if (meta.schemaVersion !== 1 || meta.revision !== revision || meta.projectId !== scope.projectId || meta.moduleId !== scope.moduleId
        || scope.workspaceId != null && meta.workspaceId !== scope.workspaceId || !/^[a-f0-9]{64}$/.test(meta.fingerprint || '')
        || !Number.isSafeInteger(meta.messageCount) || meta.messageCount < 0) throw fail('讨论存档范围或版本不一致', 'DISCUSSION_SCOPE_MISMATCH', 409);
    return meta;
  }
  async save(request) {
    keys(request, ['projectId', 'moduleId', 'workspaceId', 'name', 'snapshot'], '讨论保存请求');
    const scope = scopeValue(request), name = text(request.name, '讨论名称', 200);
    if (!name.trim()) throw fail('讨论名称不能为空');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(request), 'utf8'); } catch (_) { throw fail('讨论保存请求必须为有效JSON'); }
    if (bytes > MAX_DISCUSSION_BYTES) throw fail('讨论存档超过20MiB，未保存、未截断；已有版本仍保留', 'DISCUSSION_CAPACITY', 413);
    const snapshot = snapshotValue(request.snapshot), fingerprint = hash({ name, snapshot });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_DISCUSSION_BYTES) throw fail('讨论快照超过20MiB，未保存、未截断', 'DISCUSSION_CAPACITY', 413);
    const lockKey = path.join(this.directory, hash(scope));
    return locked(lockKey, async () => {
      const dir = await this._directory(scope, true, true);
      for (let attempt = 0; attempt < 5; attempt++) {
        const versions = await this._versions(dir), lastRevision = versions.at(-1), latest = lastRevision ? await this._meta(dir, scope, lastRevision) : null;
        if (latest?.fingerprint === fingerprint) {
          await this.get({ ...scope, revision: lastRevision });
          return { saved: true, deduplicated: true, discussion: clone(latest) };
        }
        const revision = (lastRevision || 0) + 1;
        if (revision > 999999999999) throw fail('讨论版本数量达到上限，旧版本保留', 'DISCUSSION_CAPACITY', 413);
        const now = new Date().toISOString(), meta = { schemaVersion: 1, ...scope, name, revision,
          createdAt: latest?.createdAt || now, updatedAt: now, ...description(snapshot), fingerprint };
        const temporary = path.join(dir, '.version-' + crypto.randomUUID()), target = path.join(dir, String(revision).padStart(12, '0'));
        await fs.mkdir(temporary);
        try {
          for (const [filename, value] of [['snapshot.json', snapshot], ['metadata.json', meta]]) {
            const handle = await fs.open(path.join(temporary, filename), 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
          }
          try { await fs.rename(temporary, target); }
          catch (error) {
            // Another process may have committed the same version first. Its
            // nonempty directory is never overwritten; retry with the next ID.
            const existing = await fs.lstat(target).catch(() => null);
            if (!existing?.isDirectory()) throw error;
            continue;
          }
          return { saved: true, deduplicated: false, discussion: clone(meta) };
        } finally {
          // Only our two known files in our own temporary directory are removed.
          for (const filename of ['snapshot.json', 'metadata.json']) await fs.unlink(path.join(temporary, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await fs.rmdir(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      throw fail('讨论版本并发写入繁忙，请重试；旧版本未覆盖', 'DISCUSSION_WRITE_CONFLICT', 409);
    });
  }
  async list(request) {
    keys(request, ['projectId', 'moduleId'], '讨论列表请求');
    const scope = scopeValue(request, false); let directory;
    try { directory = await this._directory(scope, false); } catch (error) { if (error.code === 'DISCUSSION_NOT_FOUND') return { discussions: [] }; throw error; }
    const discussions = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('讨论工作区目录不安全', 'DISCUSSION_UNSAFE_PATH');
      const dir = path.join(directory, entry.name), ids = await this._versions(dir); if (!ids.length) continue;
      const versions = [];
      for (const revision of ids) versions.push(await this._meta(dir, scope, revision));
      const latest = versions.at(-1);
      if (hash([scope.projectId, scope.moduleId, latest.workspaceId]) !== entry.name || versions.some(meta => meta.workspaceId !== latest.workspaceId)) throw fail('讨论工作区归属不一致', 'DISCUSSION_SCOPE_MISMATCH', 409);
      discussions.push({ ...latest, versions });
    }
    discussions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { discussions };
  }
  async get(request) {
    keys(request, ['projectId', 'moduleId', 'workspaceId', 'revision'], '讨论读取请求');
    const scope = scopeValue(request), dir = await this._directory(scope);
    const revisions = await this._versions(dir);
    const revision = request.revision == null || request.revision === '' ? revisions.at(-1) : Number(request.revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || !revisions.includes(revision)) throw fail('讨论版本不存在', 'DISCUSSION_NOT_FOUND', 404);
    const meta = await this._meta(dir, scope, revision), snapshot = snapshotValue(await this._json(path.join(dir, String(revision).padStart(12, '0')), 'snapshot.json'));
    if (hash({ name: meta.name, snapshot }) !== meta.fingerprint) throw fail('讨论版本校验不一致，未恢复或覆盖当前内容', 'DISCUSSION_CORRUPT', 409);
    return { ...meta, snapshot };
  }
}

module.exports = { LiteratureDiscussionStore, MAX_DISCUSSION_BYTES, MAX_MESSAGE_CHARS };
