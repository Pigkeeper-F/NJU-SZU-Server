'use strict';

// Read-only evidence from old rule reviews. These are partial saved fragments,
// not a reconstructed conversation, configuration or confirmation authority.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_BYTES = 20 * 1024 * 1024;
const WARNING = '旧核查记录片段，非完整聊天；仅展示实际保存的主消息和逐项问答，不恢复任务或确认状态。';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const validAt = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function sourceRef(review, origin, recordedAt, index) {
  return { reviewId: review.id, revision: review.revision, origin,
    ...(validAt(recordedAt) ? { recordedAt } : {}), ...(index == null ? {} : { index }) };
}
function mainMessages(context, source) {
  if (!plain(context) || !Array.isArray(context.messages) || !context.messages.length) return [];
  let pairs = [];
  try { const parsed = JSON.parse(source); if (Array.isArray(parsed.messages)) pairs = parsed.messages; } catch (_) { /* old source fingerprints need not include message IDs */ }
  return context.messages.map((entry, index) => {
    if (!plain(entry) || !['user', 'assistant', 'system'].includes(entry.role) || typeof entry.text !== 'string') throw fail('旧核查主消息结构无效，未重建或补造内容', 'RECOVERY_INVALID_RECORD', 409);
    const pair = pairs.length === context.messages.length && Array.isArray(pairs[index]) ? pairs[index] : [];
    return { role: entry.role, text: entry.text,
      ...(typeof entry.id === 'string' ? { id: entry.id } : typeof pair[0] === 'string' ? { id: pair[0] } : {}),
      ...(validAt(entry.at) ? { at: entry.at } : validAt(pair[1]) ? { at: pair[1] } : {}) };
  });
}
function addFragment(group, key, fragment, source) {
  const found = group.fragments.get(key);
  if (found) {
    if (!found.sources.some(entry => hash(entry) === hash(source))) found.sources.push(source);
  } else group.fragments.set(key, { ...fragment, sources: [source] });
}
function metadata(group) {
  const fragments = [...group.fragments.values()];
  const messageCount = fragments.filter(item => item.kind === 'main-context').reduce((sum, item) => sum + item.messages.length, 0);
  const questionAnswerCount = fragments.filter(item => item.kind === 'review-discussion').length;
  const times = fragments.flatMap(item => item.kind === 'main-context' ? item.messages.map(message => message.at) : [item.at]).filter(validAt).sort();
  return { id: group.id, kind: 'legacy-review-fragment', completeness: 'partial',
    label: '旧核查讨论 · ' + messageCount + ' 条主消息 · ' + questionAnswerCount + ' 轮问答',
    reviewIds: [...group.reviewIds].sort(), messageCount, questionAnswerCount, fragmentCount: fragments.length,
    earliestAt: times[0] || null, latestAt: times.at(-1) || null, warning: WARNING };
}

class LiteratureDiscussionRecovery {
  constructor(root) { this.root = path.resolve(root); }
  async _directory() {
    let current = this.root;
    for (const name of ['.workbench', 'literature-rule-reviews']) {
      current = path.join(current, name);
      const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return null;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('旧核查记录目录不安全，未读取', 'RECOVERY_UNSAFE_PATH');
    }
    return current;
  }
  async _scan() {
    const directory = await this._directory();
    if (!directory) return { groups: new Map(), issues: [] };
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => UUID.test(entry.name));
    if (entries.length > 1000) throw fail('旧核查记录超过1000份，本次未截断；请先缩小恢复范围', 'RECOVERY_CAPACITY', 413);
    const groups = new Map(), issues = []; let bytes = 0;
    for (const entry of entries) {
      const reviewDir = path.join(directory, entry.name), dirStat = await fs.lstat(reviewDir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw fail('旧核查记录目录不安全，未读取', 'RECOVERY_UNSAFE_PATH');
      const file = path.join(reviewDir, 'review.json');
      const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) { issues.push({ reviewId: entry.name, code: 'RECOVERY_MISSING_RECORD' }); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('旧核查记录文件不安全，未读取', 'RECOVERY_UNSAFE_PATH');
      bytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || bytes > MAX_SCAN_BYTES) throw fail('旧核查记录超过恢复容量，本次未截断、未修改旧记录', 'RECOVERY_CAPACITY', 413);
      let review;
      try { review = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (_) { issues.push({ reviewId: entry.name, code: 'RECOVERY_INVALID_RECORD' }); continue; }
      if (!plain(review) || review.schemaVersion !== 1 || review.id !== entry.name || !UUID.test(review.sessionId || '')
          || typeof review.workspaceId !== 'string' || !review.workspaceId.trim() || !Number.isSafeInteger(review.revision) || review.revision < 1
          || !Array.isArray(review.items) || !Array.isArray(review.sourceHistory || [])) {
        issues.push({ reviewId: entry.name, code: 'RECOVERY_INVALID_RECORD' }); continue;
      }
      // A review's current binding is only a grouping key, never applied to the
      // browser's current task. Historical snapshots stay explicit fragments.
      const id = hash(['legacy-review-fragment', review.sessionId, review.workspaceId]);
      const group = groups.get(id) || { id, reviewIds: new Set(), fragments: new Map() };
      const pending = { ...group, reviewIds: new Set(group.reviewIds), fragments: new Map([...group.fragments].map(([key, value]) => [key, { ...value, sources: value.sources.slice() }])) };
      try {
        const contexts = [{ context: review.context, source: review.source, ref: sourceRef(review, 'context', review.updatedAt) },
          ...(review.sourceHistory || []).map((saved, index) => ({ context: saved.context, source: saved.source, ref: sourceRef(review, 'sourceHistory', saved.at, index) }))];
        for (const saved of contexts) {
          const messages = mainMessages(saved.context, saved.source);
          if (messages.length) addFragment(pending, hash(['main-context', messages.map(message => [message.role, message.text])]), { kind: 'main-context', messages }, saved.ref);
        }
        for (const item of review.items) for (const discussion of item.discussion || []) {
          if (!plain(discussion) || typeof discussion.question !== 'string' || typeof discussion.answer !== 'string' || !validAt(discussion.at)) throw fail('旧核查问答结构无效', 'RECOVERY_INVALID_RECORD', 409);
          addFragment(pending, hash(['review-discussion', discussion.at, discussion.question, discussion.answer]),
            { kind: 'review-discussion', question: discussion.question, answer: discussion.answer, at: discussion.at },
            { ...sourceRef(review, 'item.discussion', discussion.at), ...(typeof item.id === 'string' ? { itemId: item.id } : {}) });
        }
        pending.reviewIds.add(review.id); groups.set(id, pending);
      } catch (_) { issues.push({ reviewId: entry.name, code: 'RECOVERY_INVALID_RECORD' }); }
    }
    return { groups, issues };
  }
  async list() {
    const { groups, issues } = await this._scan();
    return { recoveries: [...groups.values()].filter(group => group.fragments.size).map(metadata).sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || '')), issues, warning: WARNING };
  }
  async get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('旧讨论片段不存在', 'RECOVERY_NOT_FOUND', 404);
    const { groups, issues } = await this._scan(), group = groups.get(id);
    if (!group || !group.fragments.size) throw fail('旧讨论片段不存在', 'RECOVERY_NOT_FOUND', 404);
    const record = { ...metadata(group), fragments: [...group.fragments.values()], issues };
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECOVERY_BYTES) throw fail('旧讨论片段超过20MiB，本次未截断；旧记录未修改', 'RECOVERY_CAPACITY', 413);
    return record;
  }
}

module.exports = { LiteratureDiscussionRecovery, MAX_RECOVERY_BYTES };
