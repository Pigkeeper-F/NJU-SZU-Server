'use strict';

/**
 * 师生协作的服务器端存储：账号、会话、共享项目状态、提交与审核。
 *
 * 设计要点（对照主人 2026-11-25 的需求）：
 *   1. 数据落服务器，不再是各自浏览器里的孤岛；
 *   2. 师生共享同一个项目，导师能看到学生的实时状态；
 *   3. 「提交审核」= 把当前环节冻结成不可变快照，学生在审核期间继续改不影响导师看到的内容；
 *   4. 打回时批注随快照一起回到学生端，学生改完再提交新版本，旧版本全部保留可追溯。
 *
 * 落盘布局（全部在 .workbench/collab/ 下，已被 .gitignore 忽略）：
 *   accounts.json                    账号表（盐化 SHA-256，与前端原格式兼容）
 *   sessions.json                    会话 token → { userId, role, projectId, expiresAt }
 *   projects/<projectId>/state.json   项目当前状态（服务端为准；浏览器只做缓存）
 *   projects/<projectId>/submissions/<id>.json  提交快照 + 审核记录
 *
 * 安全边界：这套认证是「课堂演示级」——测试码是公开的，角色由登录时自选。
 * 它能挡住误操作和跨项目越权，但挡不住刻意冒充导师的人。真要做权限体系
 * 需要接入学校账号，不是这一版的目标（已在 docs 里写明）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROLES = ['student', 'teacher'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天，课堂场景够用
const MAX_STATE_BYTES = 8 * 1024 * 1024;           // 单项目状态上限
const MAX_SUBMISSION_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_CHARS = 8000;
const MAX_COMMENTS = 200;

// 队列：同一资源的写入串行化，避免并发请求互相覆盖
const queues = new Map();
function locked(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(work);
  queues.set(key, running);
  try { return running; } finally {
    running.finally(() => { if (queues.get(key) === running) queues.delete(key); }).catch(() => {});
  }
}

function fail(message, code = 'INVALID_COLLAB_REQUEST', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw fail(label + '必须是普通对象');
  }
  return value;
}

function text(value, label, max = 20000) {
  if (typeof value !== 'string') throw fail(label + '必须是文本');
  if (value.length > max) throw fail(label + '超过 ' + max + ' 字上限（未截断，请自行精简）');
  return value;
}

/** 标识符：拒绝路径分隔符与点开头，避免目录穿越。 */
function identifier(value, label) {
  const raw = text(value, label, 200).trim();
  if (!raw) throw fail(label + '不能为空');
  if (/[\\/\x00-\x1f]/.test(raw) || raw.startsWith('.')) throw fail(label + '含有非法字符');
  return raw;
}

/** 只允许 ASCII 字母数字与 - _ 的项目 id（前端生成的 prj_xxx / task_xxx 都满足） */
function safeId(value, label) {
  const raw = identifier(value, label);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw)) throw fail(label + '格式无效');
  return raw;
}

function isoNow() { return new Date().toISOString(); }

/**
 * 会话的归属标识：token 的 SHA-256 前 16 位。
 * 存哈希而不是 token 本身——即使提交文件被看到，也拿不到可用会话。
 * 用会话而非用户名，是为了让同名的访客互不可见（实测过同名的坑）。
 */
function ownerKeyOf(session) {
  const token = String((session && session.token) || '');
  if (!token) return 'anon';
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/** 盐化 SHA-256，与 js/auth-storage.js 的算法保持一致，老账号密码可直接沿用。 */
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password, 'utf8').digest('hex');
}

function randomSalt() { return crypto.randomBytes(16).toString('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('hex'); }

class CollabStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.base = path.join(this.root, '.workbench', 'collab');
    this.testCode = String(options.testCode || 'nailong').trim();
    this._ready = null;
  }

  /* ---------------------------------------------------------------- 基础设施 */

  async _ensure() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      await fs.mkdir(this.base, { recursive: true });
      // 目录权限收到本人：里面是账号与项目数据
      await fs.chmod(this.base, 0o700).catch(() => {});
      for (const file of ['accounts.json', 'sessions.json']) {
        const target = path.join(this.base, file);
        try { await fs.access(target); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await this._writeJsonAtomic(target, file === 'accounts.json' ? { accounts: [] } : { sessions: {} });
        }
      }
    })();
    return this._ready;
  }

  /** 原子写：写临时文件 → fsync → rename。停电/崩溃都不会留下半个文件。 */
  async _writeJsonAtomic(file, value) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
    const bytes = JSON.stringify(value, null, 2) + '\n';
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } catch (cause) {
      await fs.unlink(temp).catch(() => {});
      throw cause;
    }
  }

  async _readJson(file, fallback) {
    try {
      const stat = await fs.lstat(file);
      // 拒绝符号链接：防止有人在数据目录里塞链接把读取引到别处
      if (stat.isSymbolicLink() || !stat.isFile()) throw fail('数据文件不安全', 'COLLAB_STORAGE_UNSAFE', 500);
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (error.code === 'COLLAB_STORAGE_UNSAFE') throw error;
      if (error instanceof SyntaxError) throw fail('数据文件已损坏，未自动覆盖；请联系管理员检查 ' + file, 'COLLAB_STORAGE_CORRUPT', 500);
      throw error;
    }
  }

  /* ---------------------------------------------------------------- 账号 */

  async _readAccounts() {
    await this._ensure();
    const data = await this._readJson(path.join(this.base, 'accounts.json'), { accounts: [] });
    return Array.isArray(data.accounts) ? data : { accounts: [] };
  }

  async _writeAccounts(data) {
    await this._writeJsonAtomic(path.join(this.base, 'accounts.json'), data);
  }

  /**
   * 注册。老版本账号只存在于浏览器 localStorage，登录时会通过 adopt 自动搬上来
   * （见 login 的 legacy 参数），所以这里只处理新注册。
   */
  async register({ username, password, role }) {
    username = text(username, '账号', 64).trim();
    if (!username) throw fail('账号不能为空');
    if (/[\s\x00-\x1f]/.test(username)) throw fail('账号不能含空格或控制字符');
    if (typeof password !== 'string' || password.length < 6) throw fail('密码至少 6 位');
    if (password.length > 200) throw fail('密码过长');
    const targetRole = ROLES.includes(role) ? role : 'student';

    return locked('accounts', async () => {
      const data = await this._readAccounts();
      if (data.accounts.some(item => item && item.username === username)) {
        throw fail('该账号已被注册', 'COLLAB_ACCOUNT_EXISTS', 409);
      }
      const salt = randomSalt();
      data.accounts.push({
        username, salt, role: targetRole,
        passHash: hashPassword(password, salt),
        createdAt: isoNow()
      });
      await this._writeAccounts(data);
      return { username, role: targetRole };
    });
  }

  /* ---------------------------------------------------------------- 会话 */

  async _readSessions() {
    const data = await this._readJson(path.join(this.base, 'sessions.json'), { sessions: {} });
    return (data && typeof data.sessions === 'object' && !Array.isArray(data.sessions)) ? data.sessions : {};
  }

  async _writeSessions(sessions) {
    await this._writeJsonAtomic(path.join(this.base, 'sessions.json'), { sessions });
  }

  /** 清掉过期会话，避免文件无限增长。 */
  _pruneSessions(sessions) {
    const now = Date.now();
    let removed = 0;
    for (const [token, value] of Object.entries(sessions)) {
      if (!value || typeof value.expiresAt !== 'string' || Date.parse(value.expiresAt) < now) {
        delete sessions[token];
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 登录。
   * @param {object} input
   * @param {string} input.code 测试码
   * @param {'student'|'teacher'} input.role 登录时自选的身份（主人 2026-11-25 定）
   * @param {string} [input.username] 不填 = 访客
   * @param {string} [input.password]
   * @param {Array} [input.legacy] 浏览器里已有的账号（用于把老账号搬上服务器）
   * @param {string} [input.projectId]
   */
  async login({ code, role, username = '', password = '', legacy = null, projectId = '' }) {
    if (typeof code !== 'string' || code.trim() !== this.testCode) {
      throw fail('测试码不正确', 'COLLAB_BAD_CODE', 401);
    }
    const targetRole = ROLES.includes(role) ? role : 'student';
    const name = String(username || '').trim();
    const guest = !name;
    const targetProject = projectId ? safeId(projectId, '项目标识') : 'main';

    let resolvedRole = targetRole;
    let resolvedName = name || '访客';

    if (!guest) {
      if (typeof password !== 'string' || !password) throw fail('已填账号但没填密码', 'COLLAB_MISSING_PASSWORD');

      // 先查服务器账号；查不到再看浏览器带上来 legacy 账号，匹配成功就顺手落库
      const accounts = await this._readAccounts();
      let account = accounts.accounts.find(item => item && item.username === name);

      if (!account && Array.isArray(legacy)) {
        const candidate = legacy.find(item => item && item.username === name
          && typeof item.passHash === 'string' && typeof item.salt === 'string');
        if (candidate && candidate.passHash === hashPassword(password, String(candidate.salt))) {
          await locked('accounts', async () => {
            const fresh = await this._readAccounts();
            if (!fresh.accounts.some(item => item && item.username === name)) {
              fresh.accounts.push({
                username: name, salt: String(candidate.salt), passHash: candidate.passHash,
                role: ROLES.includes(candidate.role) ? candidate.role : 'student',
                createdAt: candidate.createdAt || isoNow(),
                adoptedFromBrowser: true
              });
              await this._writeAccounts(fresh);
            }
          });
          account = { username: name, role: 'student' };
        }
      }

      if (!account || account.passHash !== hashPassword(password, String(account.salt))) {
        // 账号不存在与密码错误统一提示，防账号枚举
        throw fail('账号或密码错误', 'COLLAB_BAD_CREDENTIALS', 401);
      }
      resolvedRole = ROLES.includes(account.role) ? account.role : 'student';
      resolvedName = account.username;
    }

    const token = randomToken();
    const session = {
      token, username: resolvedName, guest, role: resolvedRole,
      projectId: targetProject,
      createdAt: isoNow(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    };

    await locked('sessions', async () => {
      const sessions = await this._readSessions();
      this._pruneSessions(sessions);
      sessions[token] = session;
      await this._writeSessions(sessions);
    });

    return {
      token, username: resolvedName, guest, role: resolvedRole,
      projectId: targetProject, expiresAt: session.expiresAt
    };
  }

  /** 用 token 换取会话；无效/过期返回 null，由调用方回 401。 */
  async session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    await this._ensure();
    const sessions = await this._readSessions();
    const value = sessions[token];
    if (!value) return null;
    if (typeof value.expiresAt !== 'string' || Date.parse(value.expiresAt) < Date.now()) return null;
    // 【修正 · 2026-11-25】把 token 挂进返回值。
    // sessions 里存的记录本身不含 token，但 ownerKeyOf(session) 要靠它算归属标识；
    // 不挂的话所有人都会算成同一个 'anon'，访客之间的提交又会串在一起。
    // 这个字段只在服务端内部流转，不发给浏览器（各接口回包都只挑 username/role）。
    return Object.assign({}, value, { token });
  }

  async logout(token) {
    if (typeof token !== 'string') return false;
    return locked('sessions', async () => {
      const sessions = await this._readSessions();
      const had = Boolean(sessions[token]);
      delete sessions[token];
      if (had) await this._writeSessions(sessions);
      return had;
    });
  }

  /** 导师列表：登录页/导师页用来展示有哪些导师可批注。 */
  async listTeachers() {
    const data = await this._readAccounts();
    return data.accounts.filter(item => item && item.role === 'teacher').map(item => item.username);
  }

  /* ---------------------------------------------------------------- 项目状态 */

  _projectDir(projectId) {
    return path.join(this.base, 'projects', safeId(projectId, '项目标识'));
  }

  async _stateFile(projectId) { return path.join(this._projectDir(projectId), 'state.json'); }

  /**
   * 读项目当前状态。
   * -> { state, revision, updatedAt, updatedBy, exists }
   */
  async readState(projectId) {
    const file = await this._stateFile(projectId);
    const saved = await this._readJson(file, null);
    if (!saved) {
      const result = { state: null, revision: 0, updatedAt: null, updatedBy: null, exists: false };
      // 导师第一次打开一个还不存在的项目：建一个空壳，避免每次都要判断
      return result;
    }
    if (typeof saved.revision !== 'number' || !saved.state || typeof saved.state !== 'object') {
      throw fail('项目状态文件结构无效', 'COLLAB_STATE_INVALID', 500);
    }
    return {
      state: saved.state, revision: saved.revision,
      updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null, exists: true
    };
  }

  /**
   * 写项目状态。
   * 带 baseRevision 时做乐观锁：客户端读到的版本与服务器不一致 → 409，
   * 由前端提示"另一方刚改过，已为你刷新"，而不是静默覆盖别人的工作。
   */
  async writeState(projectId, { state, session, baseRevision = null }) {
    object(state, '项目状态');
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (bytes > MAX_STATE_BYTES) throw fail('项目状态超过 ' + Math.round(MAX_STATE_BYTES / 1024 / 1024) + 'MB 上限，未保存', 'COLLAB_STATE_TOO_LARGE', 413);

    return locked('state:' + projectId, async () => {
      const file = await this._stateFile(projectId);
      const current = await this._readJson(file, null);
      const currentRevision = current && typeof current.revision === 'number' ? current.revision : 0;

      if (typeof baseRevision === 'number' && baseRevision !== currentRevision) {
        throw fail('项目已被另一方修改（服务器版本 ' + currentRevision + '，你基于 ' + baseRevision + '）',
          'COLLAB_STATE_CONFLICT', 409);
      }

      const next = {
        schemaVersion: 1,
        revision: currentRevision + 1,
        state,
        updatedAt: isoNow(),
        updatedBy: session ? session.username : 'unknown',
        updatedRole: session ? session.role : 'unknown'
      };
      await this._writeJsonAtomic(file, next);
      return { revision: next.revision, updatedAt: next.updatedAt, updatedBy: next.updatedBy };
    });
  }

  /* ---------------------------------------------------------------- 提交与审核 */

  _submissionsDir(projectId) { return path.join(this._projectDir(projectId), 'submissions'); }

  async _submissionFile(projectId, submissionId) {
    return path.join(this._submissionsDir(projectId), safeId(submissionId, '提交标识') + '.json');
  }

  /**
   * 学生提交一个环节送审。
   * 把「当前环节」冻结成快照：模块内容、文档、执行记录、状态。
   * 冻结后学生继续改自己的工作副本也不会影响导师看到的内容。
   */
  async submit({ projectId, session, moduleId, moduleName, snapshot, note = '' }) {
    if (session.role !== 'student') throw fail('只有学生可以提交审核', 'COLLAB_WRONG_ROLE', 403);
    moduleId = safeId(moduleId, '环节标识');
    moduleName = text(moduleName || moduleId, '环节名称', 200);
    object(snapshot, '提交内容');
    const remark = text(note || '', '提交说明', 2000).trim();
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SUBMISSION_BYTES) {
      throw fail('提交内容过大，未保存', 'COLLAB_SUBMISSION_TOO_LARGE', 413);
    }

    const submissionId = 'sub_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    const record = {
      schemaVersion: 1,
      id: submissionId,
      projectId,
      moduleId,
      moduleName,
      version: 1,
      status: 'pending',                  // pending | approved | rejected
      submittedBy: session.username,
      // 【修正 · 2026-11-25】归属标识不能只用 username：访客登录时大家都叫「访客」，
      // 按用户名过滤会让访客 A 看到访客 B 的提交（实测确认串数据）。
      // 这里存 token 的哈希（不存 token 本身，泄露哈希也无法反推会话），
      // 每个登录会话唯一，访客之间也不互通。
      submittedByKey: ownerKeyOf(session),
      submittedAt: isoNow(),
      studentNote: remark,
      snapshot,
      review: {
        reviewedBy: null, reviewedAt: null,
        decision: null,                   // approved | rejected
        comments: []                      // [{ id, text, at, author, anchor }]
      },
      history: [{ at: isoNow(), by: session.username, action: 'submit' }]
    };

    await locked('submissions:' + projectId, async () => {
      // 同一环节已有待审的：把旧的标记为 superseded，避免导师待办列表里重复
      const dir = this._submissionsDir(projectId);
      await fs.mkdir(dir, { recursive: true });
      const files = await fs.readdir(dir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('.')) continue;
        const full = path.join(dir, file);
        const existing = await this._readJson(full, null);
        if (existing && existing.moduleId === moduleId && existing.status === 'pending') {
          existing.status = 'superseded';
          existing.history = Array.isArray(existing.history) ? existing.history : [];
          existing.history.push({ at: isoNow(), by: session.username, action: 'superseded' });
          await this._writeJsonAtomic(full, existing);
        }
      }
      // 同环节历史版本号递增，方便导师看"第几次提交"
      record.version = files.filter(name => name.startsWith('sub_')).length
        ? await this._nextVersion(projectId, moduleId)
        : 1;
      await this._writeJsonAtomic(await this._submissionFile(projectId, submissionId), record);
    });

    return this._publicSubmission(record);
  }

  async _nextVersion(projectId, moduleId) {
    const list = await this.listSubmissions(projectId, { moduleId });
    const versions = list.map(item => Number(item.version) || 0);
    return (versions.length ? Math.max(...versions) : 0) + 1;
  }

  async listSubmissions(projectId, filter = {}) {
    const dir = this._submissionsDir(projectId);
    const files = await fs.readdir(dir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const record = await this._readJson(path.join(dir, file), null);
      if (!record || typeof record.id !== 'string') continue;
      if (filter.moduleId && record.moduleId !== filter.moduleId) continue;
      if (filter.status && record.status !== filter.status) continue;
      // 归属按 key 比对；老记录没有 key 时退回用户名（兼容修复前的数据）
      if (filter.byKey && (record.submittedByKey || record.submittedBy) !== filter.byKey) continue;
      if (filter.by && record.submittedBy !== filter.by) continue;
      out.push(record);
    }
    out.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
    return out;
  }

  /** 列表用的精简视图：不含完整快照，避免一次拉回几十 MB。 */
  _publicSubmission(record, full = false) {
    const base = {
      id: record.id,
      moduleId: record.moduleId,
      moduleName: record.moduleName,
      version: record.version,
      status: record.status,
      submittedBy: record.submittedBy,
      submittedAt: record.submittedAt,
      studentNote: record.studentNote || '',
      review: {
        reviewedBy: record.review.reviewedBy,
        reviewedAt: record.review.reviewedAt,
        decision: record.review.decision,
        commentCount: Array.isArray(record.review.comments) ? record.review.comments.length : 0,
        lastComment: Array.isArray(record.review.comments) && record.review.comments.length
          ? record.review.comments[record.review.comments.length - 1]
          : null
      }
    };
    return full ? { ...base, snapshot: record.snapshot, comments: record.review.comments, history: record.history } : base;
  }

  async getSubmission(projectId, submissionId, { withSnapshot = true } = {}) {
    const file = await this._submissionFile(projectId, submissionId);
    const record = await this._readJson(file, null);
    if (!record) throw fail('提交记录不存在', 'COLLAB_SUBMISSION_NOT_FOUND', 404);
    return this._publicSubmission(record, withSnapshot);
  }

  /**
   * 导师写批注。批注是"追加"而不是覆盖——学生的每次修改都能对应到具体意见。
   * @param {object} input
   * @param {string} input.text 批注正文
   * @param {object} [input.anchor] 锚点（如 { moduleId, docSection, quote }），前端高亮用
   */
  async addComment({ projectId, session, submissionId, text: body, anchor = null }) {
    if (session.role !== 'teacher') throw fail('只有导师可以写批注', 'COLLAB_WRONG_ROLE', 403);
    const content = text(body, '批注内容', MAX_NOTE_CHARS).trim();
    if (!content) throw fail('批注内容不能为空');
    if (anchor !== null) object(anchor, '批注锚点');

    return locked('submission:' + projectId + ':' + submissionId, async () => {
      const file = await this._submissionFile(projectId, submissionId);
      const record = await this._readJson(file, null);
      if (!record) throw fail('提交记录不存在', 'COLLAB_SUBMISSION_NOT_FOUND', 404);
      if (!Array.isArray(record.review.comments)) record.review.comments = [];
      if (record.review.comments.length >= MAX_COMMENTS) throw fail('批注数量已达上限');

      const comment = {
        id: 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
        text: content,
        at: isoNow(),
        author: session.username,
        anchor: anchor || null
      };
      record.review.comments.push(comment);
      record.history.push({ at: comment.at, by: session.username, action: 'comment', commentId: comment.id });
      await this._writeJsonAtomic(file, record);
      return comment;
    });
  }

  /**
   * 导师裁决：通过或打回。通过 = 正式解锁学生下一步；打回 = 批注同步回学生端继续改。
   * 两个动作都要求导师先写过至少一条批注（打回必须有理由；通过可以留空意见）。
   */
  async review({ projectId, session, submissionId, decision, note = '' }) {
    if (session.role !== 'teacher') throw fail('只有导师可以审核', 'COLLAB_WRONG_ROLE', 403);
    if (!['approved', 'rejected'].includes(decision)) throw fail('审核结论只能是 approved 或 rejected');
    const noteText = text(note || '', '审核意见', MAX_NOTE_CHARS).trim();
    if (decision === 'rejected' && !noteText) throw fail('打回必须写明理由');

    return locked('submission:' + projectId + ':' + submissionId, async () => {
      const file = await this._submissionFile(projectId, submissionId);
      const record = await this._readJson(file, null);
      if (!record) throw fail('提交记录不存在', 'COLLAB_SUBMISSION_NOT_FOUND', 404);
      if (record.status !== 'pending') {
        throw fail('这条提交已经审过了（当前状态：' + record.status + '）', 'COLLAB_ALREADY_REVIEWED', 409);
      }

      if (noteText) {
        record.review.comments.push({
          id: 'c_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
          text: noteText, at: isoNow(), author: session.username,
          anchor: null, attachedToDecision: true
        });
      }

      record.status = decision;
      record.review.reviewedBy = session.username;
      record.review.reviewedAt = isoNow();
      record.review.decision = decision;
      record.history.push({ at: record.review.reviewedAt, by: session.username, action: decision, note: noteText });

      await this._writeJsonAtomic(file, record);
      return this._publicSubmission(record, true);
    });
  }

  /**
   * 增量轮询：从 since 之后有变化的提交记录。
   * 学生端靠这个看到"导师打回了"；导师端靠这个看到"学生新提交了"。
   * @param {object} options
   * @param {string} [options.ownerKey] 学生自己的归属标识；给了就只返回这个人的提交。
   *   用 key 而不是 username，因为访客登录时大家都叫「访客」，按名字过滤会串数据。
   */
  async changesSince(projectId, { since = null, role = 'student', ownerKey = '' } = {}) {
    const list = await this.listSubmissions(projectId, {});
    const sinceMs = since ? Date.parse(since) : 0;
    const filtered = list.filter(record => {
      const stamp = record.review.reviewedAt || record.submittedAt;
      const touched = !since || (Number.isFinite(Date.parse(stamp)) && Date.parse(stamp) > sinceMs);
      if (!touched) return false;
      // 学生只看自己这个会话的提交；导师看全部
      if (role === 'student' && ownerKey
          && (record.submittedByKey || '') !== ownerKey
          && record.submittedBy !== ownerKey) return false;
      return true;
    });
    return {
      serverTime: isoNow(),
      submissions: filtered.map(item => this._publicSubmission(item)),
      pendingCount: list.filter(item => item.status === 'pending').length
    };
  }

  /** 导师待办：所有待审提交（跨学生） */
  async pendingTodo(projectId) {
    const list = await this.listSubmissions(projectId, { status: 'pending' });
    return list.map(item => this._publicSubmission(item));
  }
}

module.exports = { CollabStore, ROLES, hashPassword, randomSalt, ownerKeyOf, SESSION_TTL_MS, MAX_STATE_BYTES };
