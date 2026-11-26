/* =========================================================
 * 研序工作台 — 文献调研的逐项核查（js/research-rule-review.js）
 * ---------------------------------------------------------
 * 为什么需要它：服务端 /api/literature/search 强制要求 reviewId，
 * 而 reviewId 只能由「逐项核查」产生（每项都要人工确认过，review.ready 才为真）。
 * 九步流程的「文献调研」面板一直没有这个入口，于是点检索必然报
 * 「请先完成逐项核查，再使用已确认配置检索」——按钮看起来是死的。
 *
 * 这里做成一个自包含的小模块：
 *   ResearchRuleReview.open(config, until, sessionId) -> Promise<{reviewId, revision} | null>
 * 点确认后逐项走完，返回可交给 /api/literature/search 的凭证。
 * 取消返回 null（调用方保持原状，不给假结果）。
 * ========================================================= */
(function (root) {
  'use strict';

  var GROUPS = [
    { id: 'scope', title: '研究范围与条件' },
    { id: 'search', title: '来源与检索式' },
    { id: 'delivery', title: '纳排与交付要求' },
    { id: 'execution', title: '执行范围与边界' }
  ];

  // 与服务端 tools/literature-rule-review.js 的 ITEMS 一一对应。
  // 只用于显示顺序与中文标签；实际取值一律以服务端返回的 review.items 为准，
  // 前端不自行拼装或推测核查内容。
  var ITEM_TITLES = {
    'topic': '研究主题',
    'years': '发表年份范围',
    'region-language': '地区与语言',
    'study-types': '研究与文献类型',
    'sources': '检索来源',
    'query': '默认检索式',
    'source-queries': '各来源检索式',
    'eligibility': '纳入和排除规则',
    'fields': '提取字段与定义',
    'templates': '交付模板',
    'search-mode': '正式或测试模式、停止方式和批次',
    'processing': '全文获取与提取设置',
    'timeouts': '各阶段超时边界',
    'stage': '本次执行到哪一步'
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('HTTP ' + response.status));
          error.code = data.code || '';
          throw error;
        }
        return data;
      });
    });
  }

  /** 把某一项的值渲染成人能读的一行（值可能是字符串、数字、数组或对象）。 */
  function formatValue(value) {
    if (value === null || value === undefined) return '（未设置）';
    if (typeof value === 'string') return value.trim() || '（空）';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (!value.length) return '（空）';
      return value.map(function (item) {
        return (item && typeof item === 'object') ? (item.label || item.name || item.key || JSON.stringify(item)) : String(item);
      }).join('、');
    }
    if (typeof value === 'object') {
      var keys = Object.keys(value);
      if (!keys.length) return '（空）';
      return keys.map(function (key) {
        var inner = value[key];
        var shown = (inner && typeof inner === 'object') ? JSON.stringify(inner) : String(inner);
        return key + '：' + shown;
      }).join('；');
    }
    return String(value);
  }

  /**
   * 取一个**服务端认账**的文献会话 id。
   * 核查与检索都绑定在这个会话上（任务目录 .workbench/<uuid>/input），
   * 所以不能凭空造 UUID：先看本地记住的那个还在不在，不在就新建一个。
   */
  var SESSION_KEY = 'yanxu_research_session';
  var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  function ensureSession() {
    var stored = '';
    try { stored = localStorage.getItem(SESSION_KEY) || ''; } catch (e) { stored = ''; }

    function create() {
      return fetch('/api/codex/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
        body: '{}'
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          var id = data && (data.id || data.sessionId);
          if (!response.ok || !id) throw new Error((data && data.error) || '无法创建文献任务会话');
          try { localStorage.setItem(SESSION_KEY, id); } catch (e) { /* 忽略 */ }
          return id;
        });
      });
    }

    if (!UUID.test(stored)) return create();
    // 验证已存的会话还在（服务器可能清理过 .workbench）
    return fetch('/api/codex/files?session=' + encodeURIComponent(stored), {
      headers: { 'X-Workbench': '1' }
    }).then(function (response) {
      return response.ok ? stored : create();
    }).catch(function () { return create(); });
  }

  /**
   * 打开核查弹窗。
   * @param {object} config 要和检索时提交的 config 完全一致（不一致服务端会拒）
   * @param {string} until  执行到哪一阶段，默认 discover
   * @param {string} sessionId 可选；不传则自动取/建一个真实会话
   * @returns {Promise<{reviewId, revision, sessionId}|null>} 取消则 resolve(null)
   */
  function open(config, until, sessionId) {
    return new Promise(function (resolve) {
      var dlg = el('dialog', 'rre-dialog');
      var form = el('form', 'rre-form');
      var title = el('h3', '', '逐项核查检索配置');
      form.appendChild(title);
      form.appendChild(el('p', 'rre-hint',
        '每一组都要点「确认本组」；全部确认后才能开始检索。任何一项没确认，检索都会被服务端拒绝——'
        + '这是为了确保真正执行的是你看过的配置。'));

      var body = el('div', 'rre-body');
      var status = el('div', 'rre-status');
      status.setAttribute('role', 'status');
      body.appendChild(el('div', 'rre-loading', '正在创建核查记录…'));
      form.appendChild(body);

      var actions = el('div', 'rre-actions');
      var cancelBtn = el('button', 'quiet-button', '取消');
      cancelBtn.type = 'button';
      var confirmAllBtn = el('button', 'quiet-button', '确认全部（跳过逐项）');
      confirmAllBtn.type = 'button';
      confirmAllBtn.hidden = true;
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmAllBtn);
      form.appendChild(actions);
      form.appendChild(status);

      dlg.appendChild(form);
      document.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');

      var review = null;
      var settled = false;
      var activeSession = sessionId && UUID.test(sessionId) ? sessionId : '';

      function close(result) {
        if (settled) return;
        settled = true;
        try { dlg.close(); } catch (e) { /* 忽略 */ }
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        resolve(result);
      }

      cancelBtn.addEventListener('click', function () { close(null); });

      function setStatus(text, tone) {
        status.textContent = text || '';
        if (tone) status.setAttribute('data-tone', tone); else status.removeAttribute('data-tone');
      }

      // ---- 渲染核查项
      function renderItems() {
        body.textContent = '';
        var items = Array.isArray(review.items) ? review.items : [];
        var confirmed = items.filter(function (item) { return item.status === 'confirmed'; }).length;

        GROUPS.forEach(function (group) {
          var groupItems = items.filter(function (item) { return item.groupId === group.id; });
          if (!groupItems.length) return;
          var box = el('section', 'rre-group');
          var head = el('div', 'rre-group-head');
          head.appendChild(el('span', 'rre-group-title', group.title));
          var done = groupItems.every(function (item) { return item.status === 'confirmed'; });
          var groupBtn = el('button', 'quiet-button rre-group-btn', done ? '✓ 已确认' : '确认本组');
          groupBtn.type = 'button';
          groupBtn.disabled = done;
          groupBtn.addEventListener('click', function () {
            groupBtn.disabled = true;
            setStatus('正在确认「' + group.title + '」…');
            post('/api/literature/rule-review/action', {
              id: review.id, sessionId: activeSession, revision: review.revision,
              action: 'group-confirm', groupId: group.id
            }).then(function (next) {
              review = next;
              setStatus('');
              renderItems();
            }).catch(function (error) {
              groupBtn.disabled = false;
              setStatus('确认失败：' + error.message, 'error');
            });
          });
          head.appendChild(groupBtn);
          box.appendChild(head);

          groupItems.forEach(function (item) {
            var row = el('div', 'rre-item');
            row.setAttribute('data-confirmed', item.status === 'confirmed' ? 'true' : 'false');
            var label = el('div', 'rre-item-title', ITEM_TITLES[item.id] || item.title || item.id);
            row.appendChild(label);
            row.appendChild(el('div', 'rre-item-value', formatValue(item.value)));
            if (item.status === 'confirmed') {
              row.appendChild(el('span', 'rre-item-badge', '已确认'));
            }
            box.appendChild(row);
          });
          body.appendChild(box);
        });

        setStatus('已确认 ' + confirmed + ' / ' + items.length + ' 项');
        confirmAllBtn.hidden = items.length > 0 && confirmed < items.length;
      }

      // ---- 一键确认全部（服务端仍逐项记录，只是省去点 4 次）
      confirmAllBtn.addEventListener('click', function () {
        confirmAllBtn.disabled = true;
        var ids = (review.groups || GROUPS).map(function (g) { return g.id; });
        setStatus('正在确认全部…');
        (function next(i) {
          if (i >= ids.length) { confirmAllBtn.disabled = false; renderItems(); return; }
          post('/api/literature/rule-review/action', {
            id: review.id, sessionId: activeSession, revision: review.revision,
            action: 'group-confirm', groupId: ids[i]
          }).then(function (nextReview) {
            review = nextReview;
            next(i + 1);
          }).catch(function (error) {
            confirmAllBtn.disabled = false;
            setStatus('确认失败：' + error.message, 'error');
          });
        })(0);
      });

      // ---- 创建核查
      // 【关键 · 2026-11-26】create 要求 sessionId 对应一个**真实的文献任务目录**
      // （服务端 codex.session() 会校验）。随便生成的 UUID 会回 SESSION_NOT_FOUND，
      // 所以先向服务端要一个会话，再拿它去建核查。
      ensureSession().then(function (sid) {
        activeSession = sid;
        return post('/api/literature/rule-review/create', {
          sessionId: sid,
          // 显式给空串：不给就是 undefined，服务端 text() 校验会判 400
          workspaceId: '',
          config: config,
          until: until || 'discover',
          source: '九步流程 · 文献调研面板'
        });
      }).then(function (created) {
        review = created;
        renderItems();
      }).catch(function (error) {
        body.textContent = '';
        body.appendChild(el('div', 'rre-error', '创建核查失败：' + error.message));
        setStatus('', 'error');
      });

      // ---- 全部确认后出现「开始检索」
      var startBtn = el('button', 'status-btn status-btn-primary', '开始检索');
      startBtn.type = 'button';
      startBtn.hidden = true;
      startBtn.addEventListener('click', function () {
        startBtn.disabled = true;
        // 只回传凭证；真正的检索由调用方发起（它才知道要轮询哪个作业）。
        // 这里不做任何"预检式"请求——空 body 打 /api/literature/search 只会产生噪音错误。
        close({ reviewId: review.id, revision: review.revision, sessionId: activeSession, config: config, until: until || 'discover' });
      });
      actions.insertBefore(startBtn, cancelBtn);

      // 监听确认进度：全部确认后显示开始按钮
      var observer = setInterval(function () {
        if (settled) { clearInterval(observer); return; }
        if (!review || !Array.isArray(review.items)) return;
        var all = review.items.length && review.items.every(function (item) { return item.status === 'confirmed'; });
        startBtn.hidden = !all;
        confirmAllBtn.hidden = all;
        if (all) setStatus('全部 ' + review.items.length + ' 项已确认，可以开始检索。', 'ok');
      }, 400);
      dlg.addEventListener('close', function () { clearInterval(observer); });
    });
  }

  root.ResearchRuleReview = { open: open, formatValue: formatValue };
})(typeof window !== 'undefined' ? window : this);
