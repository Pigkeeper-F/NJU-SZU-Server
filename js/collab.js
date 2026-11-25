/* =========================================================
 * 研序工作台 — 师生协作客户端（js/collab.js）
 * ---------------------------------------------------------
 * 依赖：无（纯 script）。服务端接口见 server.js 的 handleCollab。
 *
 * 职责：
 *   1) 登录/会话：测试码 + 自选身份（学生/导师），token 存 localStorage；
 *   2) 项目状态同步：本项目状态以服务器为准，浏览器只做本地缓存与防抖回写；
 *   3) 提交审核：把当前环节冻结成快照送到服务器，导师在那里看；
 *   4) 双向轮询：学生看导师的打回与批注，导师看学生的新提交。
 *
 * 设计取舍：
 *   - 离线可用：服务器连不上时退回纯本地模式（和老版本行为一致），
 *     不会因为后端没开就把整个工作台卡死。界面上明确标注"本地模式"。
 *   - 轮询而非 WebSocket：这套服务是零依赖裸 http，长连接要引入额外复杂度；
 *     课堂场景 5 秒轮询足够，且断线重连天然免疫。
 *   - 乐观锁：回写带 baseRevision，冲突时提示而不是静默覆盖别人的工作。
 * ========================================================= */
(function (root) {
  'use strict';

  var TOKEN_KEY = 'yanxu_collab_token';
  var USER_KEY = 'yanxu_collab_user';
  var SNAPSHOT_KEY = 'yanxu_collab_snapshot';   // 最近一次服务器快照的元信息
  var POLL_INTERVAL = 5000;
  var SAVE_DEBOUNCE = 900;

  var state = {
    token: null,
    user: null,          // { username, role, guest, projectId }
    online: false,       // 服务器是否可达
    revision: 0,         // 服务器上的项目版本
    pendingSave: false,
    lastSavedAt: null,
    lastError: null,
    syncPaused: false,   // 冲突/过期时暂停回写，避免覆盖
    pollTimer: null,
    saveTimer: null,
    listeners: []
  };

  function $(id) { return document.getElementById(id); }
  function ls() {
    try { return root.localStorage; } catch (e) { return null; }
  }
  function readLS(key, fallback) {
    try {
      var raw = ls().getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    try { ls().setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function removeLS(key) { try { ls().removeItem(key); } catch (e) { /* 忽略 */ } }

  /** 订阅状态变化（登录、同步、错误），返回 unsubscribe。 */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    state.listeners.push(fn);
    return function () {
      var i = state.listeners.indexOf(fn);
      if (i >= 0) state.listeners.splice(i, 1);
    };
  }

  function emit(type, payload) {
    for (var i = 0; i < state.listeners.length; i++) {
      try { state.listeners[i]({ type: type, payload: payload }); }
      catch (e) { if (root.console) root.console.error('[Collab] 订阅异常', e); }
    }
  }

  /** 统一的 fetch 包装：带 token、超时、错误归一。 */
  function api(path, options) {
    var opts = options || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeout || 15000) : null;

    return fetch('/api/collab' + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller ? controller.signal : undefined,
      cache: 'no-store'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('HTTP ' + response.status));
          error.code = data.code || 'COLLAB_HTTP_ERROR';
          error.status = response.status;
          throw error;
        }
        return data;
      });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /* ------------------------------------------------------------ 登录 */

  /**
   * 登录。测试码 + 自选身份（主人 2026-11-25 定：输 nailong 都能进，角色自己选）。
   * legacy：把浏览器 localStorage 里已有的老账号带上去，服务器认领后即可跨设备使用。
   */
  function login(code, role, username, password) {
    var legacy = null;
    try {
      if (root.AuthStore && typeof root.AuthStore.getAccounts === 'function') {
        legacy = root.AuthStore.getAccounts();
      }
    } catch (e) { legacy = null; }

    return api('/login', {
      body: { code: code, role: role, username: username || '', password: password || '', legacy: legacy }
    }).then(function (data) {
      state.token = data.token;
      state.user = {
        username: data.username, role: data.role,
        guest: Boolean(data.guest), projectId: data.projectId
      };
      state.online = true;
      state.lastError = null;
      writeLS(TOKEN_KEY, data.token);
      writeLS(USER_KEY, state.user);
      emit('login', state.user);
      // 登录后立刻拉一次服务器状态，决定是覆盖本地还是接续服务器
      startPolling();
      return state.user;
    });
  }

  /** 用已保存的 token 恢复会话；失效则清掉。 */
  function restore() {
    var token = readLS(TOKEN_KEY, null);
    var user = readLS(USER_KEY, null);
    if (!token || !user) return Promise.resolve(null);
    state.token = token;
    state.user = user;
    return api('/session').then(function (data) {
      state.user = {
        username: data.username, role: data.role,
        guest: Boolean(data.guest), projectId: data.projectId
      };
      state.online = true;
      writeLS(USER_KEY, state.user);
      startPolling();
      emit('login', state.user);
      return state.user;
    }).catch(function (error) {
      if (error.status === 401) logout(true);
      return null;
    });
  }

  function logout(silent) {
    var token = state.token;
    stopPolling();
    state.token = null;
    state.user = null;
    state.online = false;
    state.revision = 0;
    state.syncPaused = false;
    removeLS(TOKEN_KEY);
    removeLS(USER_KEY);
    if (!silent) emit('logout', null);
    if (token && !silent) api('/logout', { body: {} }).catch(function () {});
  }

  /* ------------------------------------------------------------ 项目状态同步 */

  /**
   * 拉服务器上的项目状态。
   * -> { state, revision, exists }
   * 本地没有状态、服务器有 → 用服务器的（学生换设备登录能接着干）。
   * 本地有、服务器没有 → 首次上传本地（老用户第一次上台）。
   */
  function pullState() {
    return api('/state').then(function (data) {
      state.online = true;
      state.revision = data.revision || 0;
      state.lastError = null;
      return data;
    }).catch(function (error) {
      state.online = false;
      state.lastError = error.message;
      throw error;
    });
  }

  /**
   * 把本地状态推到服务器。
   * @param {object} projectState Store.getState() 的结果
   * @param {object} [options] { force: 忽略冲突强制覆盖 }
   */
  function pushState(projectState, options) {
    var opts = options || {};
    if (state.syncPaused && !opts.force) {
      return Promise.reject(new Error('同步已暂停（有冲突待处理）'));
    }
    return api('/state', {
      method: 'PUT',
      body: {
        state: projectState,
        baseRevision: opts.force ? null : state.revision
      }
    }).then(function (data) {
      state.revision = data.revision;
      state.lastSavedAt = data.updatedAt;
      state.online = true;
      state.lastError = null;
      state.syncPaused = false;
      emit('saved', data);
      return data;
    }).catch(function (error) {
      if (error.code === 'COLLAB_STATE_CONFLICT') {
        state.syncPaused = true;
        emit('conflict', error);
      } else {
        state.online = false;
        state.lastError = error.message;
      }
      throw error;
    });
  }

  /** 防抖回写：Store 每次变更都会调它，避免每个字符都打一次网络。 */
  function scheduleSave(getState) {
    if (!state.user) return;
    state.pendingSave = true;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      state.pendingSave = false;
      var snapshot;
      try { snapshot = getState(); } catch (e) { return; }
      if (!snapshot) return;
      pushState(snapshot).catch(function () { /* 失败已在 state 里记录，界面会显示 */ });
    }, SAVE_DEBOUNCE);
  }

  /* ------------------------------------------------------------ 提交审核 */

  /**
   * 学生提交一个环节送审。
   * 快照在**服务端**冻结：这里只把当前模块内容整块传过去，
   * 之后学生继续改本地内容也不影响导师看到的那一版。
   */
  function submitForReview(module, note) {
    if (!state.user) return Promise.reject(new Error('未登录'));
    if (state.user.role !== 'student') return Promise.reject(new Error('只有学生可以提交审核'));
    if (!module || !module.id) return Promise.reject(new Error('没有可提交的环节'));

    var snapshot = {
      moduleId: module.id,
      name: module.name,
      type: module.type || null,
      status: module.status || 'todo',
      doc: module.doc ? { content: module.doc.content, status: module.doc.status, updatedAt: module.doc.updatedAt } : null,
      run: module.run ? { status: module.run.status, at: module.run.at, dir: module.run.dir, artifacts: module.run.artifacts } : null,
      messages: (module.messages || []).slice(-40).map(function (item) {
        return { role: item.role, text: item.text, at: item.at };
      }),
      capturedAt: new Date().toISOString()
    };

    return api('/submit', {
      body: { moduleId: module.id, moduleName: module.name || module.id, snapshot: snapshot, note: note || '' }
    });
  }

  function listSubmissions(filter) {
    var query = [];
    if (filter && filter.moduleId) query.push('module=' + encodeURIComponent(filter.moduleId));
    if (filter && filter.status) query.push('status=' + encodeURIComponent(filter.status));
    return api('/submissions' + (query.length ? '?' + query.join('&') : ''));
  }

  function getSubmission(id) {
    return api('/submissions/' + encodeURIComponent(id));
  }

  function getTodo() {
    return api('/todo');
  }

  function addComment(submissionId, text, anchor) {
    return api('/comment', { body: { submissionId: submissionId, text: text, anchor: anchor || null } });
  }

  function review(submissionId, decision, note) {
    return api('/review', { body: { submissionId: submissionId, decision: decision, note: note || '' } });
  }

  /* ------------------------------------------------------------ 轮询 */

  function startPolling() {
    stopPolling();
    if (!state.user) return;

    // 【优化 · 2026-11-25】页面在后台时不轮询：浏览器标签被藏起来（切到别的应用、
    // 或者主动最小化），用户根本看不到更新，继续每 5 秒打一次服务器纯属浪费。
    // 回到前台立刻补一次，保证不会因为"没轮询"而看到过期数据。
    function tick() {
      api('/changes?since=' + encodeURIComponent(state.lastPollAt || ''))
        .then(function (data) {
          state.online = true;
          state.lastPollAt = data.serverTime;
          state.lastError = null;
          if (data.pendingCount > 0) emit('todo:update', data);
          if (data.submissions && data.submissions.length) emit('changes', data);
        })
        .catch(function (error) {
          state.online = false;
          state.lastError = error.message;
          if (error.status === 401) {
            stopPolling();
            emit('session:expired', error);
          }
        });
    }

    state.pollTimer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;
      tick();
    }, POLL_INTERVAL);

    // 从后台切回来时立刻拉一次，不用等下一个 5 秒
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      if (!state.visibilityBound) {
        state.visibilityBound = true;
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden && state.user && state.pollTimer) tick();
        });
      }
    }
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  /* ------------------------------------------------------------ 导出 */

  root.Collab = {
    // 状态
    getState: function () {
      return {
        token: state.token, user: state.user, online: state.online,
        revision: state.revision, lastSavedAt: state.lastSavedAt,
        lastError: state.lastError, syncPaused: state.syncPaused
      };
    },
    isLoggedIn: function () { return Boolean(state.token && state.user); },
    isTeacher: function () { return Boolean(state.user && state.user.role === 'teacher'); },
    isStudent: function () { return Boolean(state.user && state.user.role === 'student'); },
    subscribe: subscribe,

    // 登录
    login: login,
    restore: restore,
    logout: logout,

    // 同步
    pullState: pullState,
    pushState: pushState,
    scheduleSave: scheduleSave,

    // 审核
    submitForReview: submitForReview,
    listSubmissions: listSubmissions,
    getSubmission: getSubmission,
    getTodo: getTodo,
    addComment: addComment,
    review: review,

    // 轮询
    startPolling: startPolling,
    stopPolling: stopPolling
  };
})(typeof window !== 'undefined' ? window : this);
