/* =========================================================
 * 研序工作台 — 师生协作面板（js/collab-ui.js）
 * ---------------------------------------------------------
 * 依赖：js/collab.js（提供 window.Collab）、js/store.js（读当前环节内容）
 *
 * 两种形态，同一套代码按角色切换：
 *   学生：侧栏「我的提交」→ 看自己每次提交的状态（待审/通过/打回）+ 导师批注
 *   导师：侧栏「审核待办」→ 看待审列表，点开看学生冻结的那一版内容，写批注、通过/打回
 *
 * 为什么做成侧栏抽屉而不是新页面：
 *   学生的动作发生在环节里（"我现在做完这一节了，提交给老师"），
 *   跳走会丢掉上下文；抽屉能边看自己的内容边看老师意见。
 * ========================================================= */
(function (root) {
  'use strict';

  var STATUS_TEXT = {
    pending: { label: '待导师审核', tone: 'pending' },
    approved: { label: '导师已通过', tone: 'ok' },
    rejected: { label: '导师已打回', tone: 'bad' },
    superseded: { label: '已被新提交替代', tone: 'muted' }
  };

  var drawer = null;      // 抽屉根节点
  var panelBody = null;
  var currentTab = 'list'; // list | detail
  var selectedId = null;
  var cache = { items: [], todo: [], fetchedAt: 0 };
  var badge = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function isTeacher() {
    return !!(root.Collab && root.Collab.isTeacher && root.Collab.isTeacher());
  }

  /* --------------------------------------------------------- 抽屉骨架 */

  function ensureDrawer() {
    if (drawer) return drawer;

    drawer = el('aside', 'collab-drawer');
    drawer.id = 'collab-drawer';
    drawer.setAttribute('aria-label', '师生协作面板');
    drawer.hidden = true;

    var head = el('div', 'collab-head');
    var title = el('div', 'collab-title', isTeacher() ? '审核待办' : '我的提交');
    title.id = 'collab-title';
    head.appendChild(title);

    var close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭协作面板');
    close.addEventListener('click', function () { hide(); });
    head.appendChild(close);
    drawer.appendChild(head);

    var meta = el('div', 'collab-meta');
    meta.id = 'collab-meta';
    drawer.appendChild(meta);

    panelBody = el('div', 'collab-body');
    panelBody.id = 'collab-body';
    drawer.appendChild(panelBody);

    document.body.appendChild(drawer);
    return drawer;
  }

  function show() {
    ensureDrawer();
    drawer.hidden = false;
    document.body.classList.add('collab-open');
    reload();
  }

  function hide() {
    if (drawer) drawer.hidden = true;
    document.body.classList.remove('collab-open');
  }

  function toggle() {
    ensureDrawer();
    if (drawer.hidden) show(); else hide();
  }

  /* --------------------------------------------------------- 数据 */

  function reload() {
    if (!root.Collab || !root.Collab.isLoggedIn()) {
      renderMessage('还没有登录，无法使用协作功能。');
      return;
    }
    // 【修复 · 2026-11-25】正在看某条详情时，轮询刷新不能把画面踹回列表。
    // 实测：点开详情 120ms 就能渲染出来，1.8 秒后被轮询的列表覆盖，
    // 用户看到的是"点了没反应"。这里改为只更新数据与角标，不动当前画面。
    var viewingDetail = currentTab === 'detail' && Boolean(selectedId);

    if (!viewingDetail) renderMessage('正在读取…');
    var fetcher = isTeacher() ? root.Collab.getTodo() : root.Collab.listSubmissions();
    fetcher.then(function (data) {
      var list = isTeacher() ? (data.todo || []) : (data.submissions || []);
      cache.items = list;
      cache.fetchedAt = Date.now();
      updateBadge();
      if (viewingDetail) { updateMetaLine(); return; }
      renderList();
    }).catch(function (error) {
      if (viewingDetail) return;   // 看详情时后台请求失败，别打断阅读
      renderMessage('读取失败：' + (error.message || '网络异常'), 'error');
    });
  }

  /** 只刷新顶部统计行，不动主体内容（详情页刷新用）。 */
  function updateMetaLine() {
    var metaBox = document.getElementById('collab-meta');
    if (!metaBox) return;
    var pending = cache.items.filter(function (item) { return item.status === 'pending'; }).length;
    metaBox.textContent = '';
    metaBox.appendChild(el('span', '', isTeacher()
      ? '待审 ' + pending + ' 项 · 共 ' + cache.items.length + ' 次提交'
      : '共 ' + cache.items.length + ' 次提交'));
    var refresh = el('button', 'quiet-button', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { renderList(); reload(); });
    metaBox.appendChild(refresh);
  }

  function renderMessage(text, tone) {
    if (!panelBody) return;
    panelBody.textContent = '';
    var box = el('div', 'collab-message', text);
    if (tone) box.setAttribute('data-tone', tone);
    panelBody.appendChild(box);
  }

  /* --------------------------------------------------------- 列表 */

  function renderList() {
    if (!panelBody) return;
    panelBody.textContent = '';
    currentTab = 'list';

    var metaBox = document.getElementById('collab-meta');
    if (metaBox) {
      metaBox.textContent = '';
      var pending = cache.items.filter(function (item) { return item.status === 'pending'; }).length;
      metaBox.appendChild(el('span', '', isTeacher()
        ? '待审 ' + pending + ' 项 · 共 ' + cache.items.length + ' 次提交'
        : '共 ' + cache.items.length + ' 次提交'));
      var refresh = el('button', 'quiet-button', '刷新');
      refresh.type = 'button';
      refresh.addEventListener('click', reload);
      metaBox.appendChild(refresh);
    }

    if (!cache.items.length) {
      panelBody.appendChild(el('div', 'collab-empty',
        isTeacher() ? '还没有学生提交审核。学生点「提交给导师审核」后会出现在这里。'
                    : '还没有提交记录。做完一个环节后点「提交给导师审核」。'));
      return;
    }

    var list = el('div', 'collab-list');
    cache.items.forEach(function (item) {
      list.appendChild(renderRow(item));
    });
    panelBody.appendChild(list);
  }

  function renderRow(item) {
    var row = el('button', 'collab-row');
    row.type = 'button';
    row.setAttribute('data-status', item.status);

    var top = el('div', 'collab-row-top');
    top.appendChild(el('span', 'collab-row-name', item.moduleName || item.moduleId));
    top.appendChild(el('span', 'collab-row-badge', (STATUS_TEXT[item.status] || {}).label || item.status));
    row.appendChild(top);

    var meta = el('div', 'collab-row-meta');
    meta.appendChild(el('span', '', 'v' + item.version));
    meta.appendChild(el('span', '', item.submittedBy));
    meta.appendChild(el('span', '', fmtTime(item.submittedAt)));
    if (item.review && item.review.commentCount) {
      meta.appendChild(el('span', 'collab-row-comments', '💬 ' + item.review.commentCount));
    }
    row.appendChild(meta);

    // 打回时直接露出导师最后一句，学生不用点进去也知道要改什么
    if (item.status === 'rejected' && item.review && item.review.lastComment) {
      row.appendChild(el('div', 'collab-row-last', item.review.lastComment.text));
    }
    if (item.status === 'pending' && isTeacher()) {
      row.appendChild(el('div', 'collab-row-hint', '点击查看内容并批注'));
    }

    row.addEventListener('click', function () { openDetail(item.id); });
    return row;
  }

  /* --------------------------------------------------------- 详情 */

  function openDetail(id) {
    selectedId = id;
    currentTab = 'detail';
    if (!panelBody) return;
    panelBody.textContent = '';
    panelBody.appendChild(el('div', 'collab-message', '正在读取提交内容…'));

    root.Collab.getSubmission(id).then(function (record) {
      panelBody.textContent = '';
      panelBody.appendChild(renderDetail(record));
    }).catch(function (error) {
      panelBody.textContent = '';
      panelBody.appendChild(el('div', 'collab-message', '读取失败：' + (error.message || '网络异常')));
    });
  }

  function renderDetail(record) {
    var box = el('div', 'collab-detail');

    // 返回
    var back = el('button', 'collab-back', '← 返回列表');
    back.type = 'button';
    back.addEventListener('click', renderList);
    box.appendChild(back);

    // 标题区
    var head = el('div', 'collab-detail-head');
    head.appendChild(el('h3', '', record.moduleName || record.moduleId));
    var badge = el('span', 'collab-row-badge', (STATUS_TEXT[record.status] || {}).label || record.status);
    badge.setAttribute('data-status', record.status);
    head.appendChild(badge);
    box.appendChild(head);

    var meta = el('div', 'collab-detail-meta');
    meta.appendChild(el('span', '', '第 ' + record.version + ' 次提交'));
    meta.appendChild(el('span', '', '提交人：' + record.submittedBy));
    meta.appendChild(el('span', '', fmtTime(record.submittedAt)));
    box.appendChild(meta);

    if (record.studentNote) {
      var noteBox = el('section', 'collab-section');
      noteBox.appendChild(el('h4', '', '学生说明'));
      noteBox.appendChild(el('p', 'collab-text', record.studentNote));
      box.appendChild(noteBox);
    }

    // ---- 冻结的内容
    var snapshot = record.snapshot || {};
    var contentBox = el('section', 'collab-section');
    contentBox.appendChild(el('h4', '', '提交内容（提交时冻结）'));

    if (snapshot.doc && snapshot.doc.content) {
      contentBox.appendChild(el('div', 'collab-label', '环节文档'));
      var doc = el('pre', 'collab-doc', snapshot.doc.content);
      contentBox.appendChild(doc);
    }
    if (snapshot.run) {
      contentBox.appendChild(el('div', 'collab-label', '执行记录'));
      var runLine = el('p', 'collab-text', '状态：' + snapshot.run.status +
        (snapshot.run.at ? ' · ' + fmtTime(snapshot.run.at) : ''));
      contentBox.appendChild(runLine);
      if (Array.isArray(snapshot.run.artifacts) && snapshot.run.artifacts.length) {
        var ul = el('ul', 'collab-artifacts');
        snapshot.run.artifacts.forEach(function (art) {
          ul.appendChild(el('li', '', art.name + (art.size ? ' （' + art.size + '）' : '')));
        });
        contentBox.appendChild(ul);
      }
    }
    if (Array.isArray(snapshot.messages) && snapshot.messages.length) {
      contentBox.appendChild(el('div', 'collab-label', '最近对话（' + snapshot.messages.length + ' 条）'));
      var msgs = el('div', 'collab-messages');
      snapshot.messages.slice(-10).forEach(function (item) {
        var line = el('div', 'collab-msg');
        line.setAttribute('data-role', item.role || 'user');
        line.appendChild(el('span', 'collab-msg-role', item.role === 'assistant' ? 'AI' : item.role === 'system' ? '系统' : '我'));
        line.appendChild(el('span', 'collab-msg-text', item.text || ''));
        msgs.appendChild(line);
      });
      contentBox.appendChild(msgs);
    }
    if (!contentBox.querySelector('.collab-label') && !contentBox.querySelector('pre')) {
      contentBox.appendChild(el('p', 'collab-text collab-muted', '这一版没有可展示的文档或执行产物。'));
    }
    box.appendChild(contentBox);

    // ---- 批注
    var comments = record.comments || [];
    var cmtBox = el('section', 'collab-section');
    cmtBox.appendChild(el('h4', '', '导师批注' + (comments.length ? '（' + comments.length + '）' : '')));
    if (!comments.length) {
      cmtBox.appendChild(el('p', 'collab-text collab-muted', '还没有批注。'));
    } else {
      comments.forEach(function (item) {
        var row = el('div', 'collab-comment');
        row.appendChild(el('div', 'collab-comment-head',
          item.author + ' · ' + fmtTime(item.at) + (item.attachedToDecision ? ' · 随审核结论' : '')));
        row.appendChild(el('div', 'collab-comment-text', item.text));
        cmtBox.appendChild(row);
      });
    }
    box.appendChild(cmtBox);

    // ---- 导师操作区
    if (isTeacher() && record.status === 'pending') {
      box.appendChild(renderTeacherActions(record));
    }

    // ---- 学生端：被打回时给一句明确的下一步
    if (!isTeacher() && record.status === 'rejected') {
      var tip = el('div', 'collab-next');
      tip.appendChild(el('strong', '', '需要你修改'));
      tip.appendChild(el('p', '', '按上面导师的批注改完，再点环节里的「提交给导师审核」提交新版本。旧版本会保留记录。'));
      box.appendChild(tip);
    }

    return box;
  }

  function renderTeacherActions(record) {
    var section = el('section', 'collab-section collab-actions');

    section.appendChild(el('h4', '', '写批注'));
    var textarea = el('textarea', 'collab-input');
    textarea.rows = 3;
    textarea.placeholder = '指出具体问题或需要补充的内容（可写多条）';
    section.appendChild(textarea);

    var addRow = el('div', 'collab-btn-row');
    var addBtn = el('button', 'status-btn', '添加批注');
    addBtn.type = 'button';
    var addStatus = el('span', 'collab-inline-status');
    addBtn.addEventListener('click', function () {
      var value = (textarea.value || '').trim();
      if (!value) { addStatus.textContent = '批注内容不能为空'; return; }
      addBtn.disabled = true;
      addStatus.textContent = '提交中…';
      root.Collab.addComment(record.id, value).then(function () {
        addBtn.disabled = false;
        textarea.value = '';
        addStatus.textContent = '已添加';
        openDetail(record.id);   // 重新拉一遍，批注立刻出现
      }).catch(function (error) {
        addBtn.disabled = false;
        addStatus.textContent = '失败：' + (error.message || '网络异常');
      });
    });
    addRow.appendChild(addBtn);
    addRow.appendChild(addStatus);
    section.appendChild(addRow);

    section.appendChild(el('h4', '', '审核结论'));

    var decisionNote = el('textarea', 'collab-input');
    decisionNote.rows = 2;
    decisionNote.placeholder = '审核意见（打回时必须写理由）';
    section.appendChild(decisionNote);

    var decideRow = el('div', 'collab-btn-row');
    var status = el('span', 'collab-inline-status');

    var approve = el('button', 'status-btn status-btn-primary', '审核通过');
    approve.type = 'button';
    approve.addEventListener('click', function () {
      decide('approved', approve);
    });

    var reject = el('button', 'status-btn collab-btn-danger', '打回重做');
    reject.type = 'button';
    reject.addEventListener('click', function () {
      decide('rejected', reject);
    });

    function decide(decision, button) {
      var note = (decisionNote.value || '').trim();
      if (decision === 'rejected' && !note) {
        status.textContent = '打回必须写明理由';
        decisionNote.focus();
        return;
      }
      approve.disabled = true; reject.disabled = true;
      status.textContent = '提交中…';
      root.Collab.review(record.id, decision, note).then(function () {
        status.textContent = decision === 'approved' ? '已通过' : '已打回';
        // 通过 = 学生那边正式解锁下一步；这里顺带把本地环节状态推进
        if (decision === 'approved') advanceLocalModule(record.moduleId);
        setTimeout(reload, 600);
      }).catch(function (error) {
        approve.disabled = false; reject.disabled = false;
        status.textContent = '失败：' + (error.message || '网络异常');
      });
    }

    decideRow.appendChild(approve);
    decideRow.appendChild(reject);
    decideRow.appendChild(status);
    section.appendChild(decideRow);

    return section;
  }

  /** 导师通过后，若本地也有这个环节且未通过，就跟着置为已通过（只改本地显示）。 */
  function advanceLocalModule(moduleId) {
    try {
      var Store = root.Store;
      if (!Store || typeof Store.getState !== 'function') return;
      var state = Store.getState();
      var mod = (state.modules || []).filter(function (item) { return item.id === moduleId; })[0];
      if (mod && mod.status !== 'approved' && typeof Store.setModuleStatus === 'function') {
        Store.setModuleStatus(moduleId, 'approved');
      }
    } catch (e) { /* 本地推进失败不影响服务端记录 */ }
  }

  /* --------------------------------------------------------- 侧栏入口 */

  function ensureEntry() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return null;
    if (document.getElementById('collab-entry')) return document.getElementById('collab-entry');

    var btn = el('button', 'quiet-button collab-entry');
    btn.id = 'collab-entry';
    btn.type = 'button';
    btn.innerHTML = '<span aria-hidden="true">◎</span><span class="collab-entry-label"></span>';
    btn.addEventListener('click', toggle);

    var label = btn.querySelector('.collab-entry-label');
    label.textContent = isTeacher() ? '审核待办' : '我的提交';

    badge = el('span', 'collab-badge');
    badge.id = 'collab-badge';
    badge.hidden = true;
    btn.appendChild(badge);

    var footer = sidebar.querySelector('.sidebar-footer');
    if (footer && footer.parentNode === sidebar) sidebar.insertBefore(btn, footer);
    else sidebar.appendChild(btn);
    return btn;
  }

  function updateBadge() {
    if (!badge) return;
    var count = cache.items.filter(function (item) {
      if (isTeacher()) return item.status === 'pending';
      // 学生：被打了回但还没重新提交的（同一环节取最新一条）
      return item.status === 'rejected';
    }).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  }

  /* --------------------------------------------------------- 初始化 */

  /**
   * 初始化。
   * 注意顺序：collab-ui.js 在 index.html 末尾加载，那时 guard.js 已经放行、
   * 但 collab.js 的 session 还没恢复（token 在 localStorage 里，要等
   * collab-boot.js 异步 restore 完才算登录）。所以这里不能只看一次
   * isLoggedIn() 就决定挂不挂入口，而要订阅登录事件，登录成功后再挂。
   */
  function init() {
    if (!root.Collab) return;

    // 订阅要在 restore 之前注册，才能接住随后到来的 login 事件
    root.Collab.subscribe(function (event) {
      if (event.type === 'login') {
        ensureEntry();
        updateBadge();
        reload();
        return;
      }
      if (event.type === 'changes' || event.type === 'todo:update') {
        reload();
        return;
      }
      if (event.type === 'logout') {
        var entry = document.getElementById('collab-entry');
        if (entry) entry.remove();
        hide();
      }
    });

    // 已经登录（比如脚本晚于 restore 执行）就立刻挂上
    if (root.Collab.isLoggedIn()) {
      ensureEntry();
      updateBadge();
      reload();
    }
  }

  root.CollabUI = {
    init: init,
    show: show,
    hide: hide,
    toggle: toggle,
    reload: reload,
    // 供 chat.js 的「提交给导师审核」按钮调用
    submitCurrent: function (module, note) {
      if (!root.Collab || !root.Collab.isLoggedIn()) {
        return Promise.reject(new Error('还没有登录'));
      }
      return root.Collab.submitForReview(module, note);
    }
  };

  init();
})(typeof window !== 'undefined' ? window : this);
