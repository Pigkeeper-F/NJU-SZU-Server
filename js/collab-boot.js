/* =========================================================
 * 研序工作台 — 协作层启动（js/collab-boot.js）
 * ---------------------------------------------------------
 * 依赖：js/collab.js、js/collab-ui.js、js/store.js
 * 必须在所有页面脚本之后加载（index.html 末尾）。
 *
 * 做的事：
 *   1) 恢复服务器会话（token 还在就别让人重登）；
 *   2) 首屏决定数据归属：服务器有状态就用服务器的，本地有服务器没有就上传；
 *   3) 把 Store 的每次变更防抖推到服务器；
 *   4) 在状态条上标注"在线同步 / 本地模式"，不让人猜数据到底存哪。
 *
 * 失败策略：任何一步失败都只是降级为本地模式，绝不阻断工作台。
 * 课堂现场服务器抖一下就白屏，比数据没同步更糟。
 * ========================================================= */
(function (root) {
  'use strict';

  var state = {
    mode: 'local',        // local | online | syncing | conflict
    message: '',
    booted: false
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  /* --------------------------------------------------------- 状态标签 */

  function ensureStatusChip() {
    var chip = document.getElementById('collab-sync-chip');
    if (chip) return chip;
    var host = document.getElementById('auth-user');
    if (!host || !host.parentNode) return null;
    chip = el('span', 'collab-sync-chip');
    chip.id = 'collab-sync-chip';
    chip.title = '数据保存位置';
    host.parentNode.appendChild(chip);
    return chip;
  }

  function renderStatus() {
    var chip = ensureStatusChip();
    if (!chip) return;
    var text = '';
    chip.removeAttribute('data-mode');
    switch (state.mode) {
      case 'online':
        text = '☁ 已同步';
        chip.setAttribute('data-mode', 'online');
        break;
      case 'syncing':
        text = '↻ 同步中';
        chip.setAttribute('data-mode', 'syncing');
        break;
      case 'conflict':
        text = '⚠ 有冲突';
        chip.setAttribute('data-mode', 'conflict');
        break;
      default:
        text = '本机存储';
        chip.setAttribute('data-mode', 'local');
    }
    chip.textContent = text;
    chip.title = state.message || (
      state.mode === 'online' ? '数据已保存到服务器，换设备登录也能接着用'
        : state.mode === 'conflict' ? '服务器上已有更新的版本，点开协作面板可查看'
        : state.mode === 'syncing' ? '正在保存到服务器…'
        : '未连接服务器：数据只在本浏览器'
    );
  }

  function setMode(mode, message) {
    state.mode = mode;
    state.message = message || '';
    renderStatus();
  }

  /* --------------------------------------------------------- 冒烟检查：首次上传本地状态 */

  function pushLocalIfServerEmpty(serverState) {
    var Store = root.Store;
    if (!Store || typeof Store.getState !== 'function') return Promise.resolve();
    var local = null;
    try { local = Store.getState(); } catch (e) { return Promise.resolve(); }
    if (!local) return Promise.resolve();

    var localHasContent = Array.isArray(local.modules) && local.modules.length > 0;
    var serverHasContent = serverState && Array.isArray(serverState.modules) && serverState.modules.length > 0;
    if (serverHasContent) return Promise.resolve();
    if (!localHasContent) {
      // 两边都空：正常的新项目起点，不标记成同步中（否则标签永远转圈）
      setMode('online', '已连接服务器（项目还是空的）');
      return Promise.resolve();
    }

    // 服务器空、本地有 → 把本地推上去（老用户第一次上台）
    setMode('syncing');
    return root.Collab.pushState(local, { force: true }).then(function () {
      setMode('online', '已把本机的项目内容上传到服务器');
    }).catch(function (error) {
      setMode('local', '上传本地内容失败：' + (error.message || '网络异常'));
    });
  }

  /* --------------------------------------------------------- 启动 */

  function boot() {
    if (state.booted) return;
    state.booted = true;

    var Collab = root.Collab;
    renderStatus();

    if (!Collab) {
      setMode('local', '协作层未加载（可能页面是 file:// 直接打开的）');
      return;
    }

    Collab.restore().then(function (user) {
      if (!user) {
        setMode('local', '未登录服务器：数据只在本浏览器');
        return;
      }
      renderStatus();

      // 会话恢复成功 → 拉服务器状态
      setMode('syncing');
      return Collab.pullState().then(function (data) {
        if (data.exists && data.state) {
          // 服务器有数据：以服务器为准（学生换设备登录能接着干）
          var Store = root.Store;
          if (Store && typeof Store.restoreState === 'function') {
            // 复用 store 自己的 sanitize 校验：服务器数据也要过一遍结构检查，
            // 不能因为"来自服务器"就盲信。
            if (Store.restoreState(data.state)) {
              setMode('online', '已从服务器载入项目（版本 ' + data.revision +
                '，最后由 ' + (data.updatedBy || '未知') + ' 保存）');
              return undefined;
            }
            setMode('local', '服务器上的项目结构无法识别，已保留本地内容');
            return undefined;
          }
          return pushLocalIfServerEmpty(data.state);
        }
        return pushLocalIfServerEmpty(data.state);
      }).then(function () {
        bindStoreSync();
      });
    }).catch(function (error) {
      setMode('local', '连接服务器失败：' + (error && error.message ? error.message : '网络异常'));
    });

    // 冲突：暂停回写，提示用户
    Collab.subscribe(function (event) {
      if (event.type === 'conflict') {
        setMode('conflict', '服务器上已有更新的版本。你的改动暂未上传，点「我的提交」查看，或刷新页面载入最新版本。');
      }
      if (event.type === 'saved') {
        setMode('online');
      }
      if (event.type === 'logout') {
        setMode('local', '已退出登录：数据只在本浏览器');
      }
      if (event.type === 'session:expired') {
        setMode('local', '登录已过期，请重新登录后继续同步');
        showReloginBanner();
      }
    });
  }

  /**
   * 【优化 · 2026-11-25】会话过期时给一条明确的横幅。
   * 只把侧栏小标签变灰是不够的——用户根本不会去盯那个标签，
   * 结果就是"我明明改了，怎么服务器上没有"，其实早掉线了。
   * 横幅带一个直接跳登录页的按钮，且不阻塞工作（本地仍能继续干）。
   */
  function showReloginBanner() {
    if (document.getElementById('collab-relogin-banner')) return;
    var box = el('div', 'collab-relogin-banner');
    box.id = 'collab-relogin-banner';
    box.setAttribute('role', 'alert');

    box.appendChild(el('span', 'collab-relogin-text',
      '与服务器的连接已过期：现在的改动只保存在本机，导师看不到。'));

    var link = el('a', 'collab-relogin-link', '重新登录');
    link.href = 'login.html';
    box.appendChild(link);

    var close = el('button', 'collab-relogin-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭提示');
    close.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    box.appendChild(close);

    document.body.appendChild(box);
  }

  /** 把 Store 的变更接到防抖回写。只绑一次。 */
  var bound = false;
  function bindStoreSync() {
    if (bound) return;
    var Store = root.Store;
    if (!Store || typeof Store.subscribe !== 'function') return;
    bound = true;
    Store.subscribe(function (event) {
      // 只同步真正改变项目内容的变更；UI 类事件（选中、侧栏宽度）不值得打网络。
      // 【修正 · 2026-11-25】原白名单漏了 module:mode / module:param / flow:init
      // / flow:start / run:invalidate —— 这些都会改项目内容，漏掉就会"改了没同步"。
      // 反过来，state:reset 从白名单**移除**（见下）。
      var meaningful = /^(module:add|module:remove|module:rename|module:status|module:mode|module:param|message:append|doc:save|doc:approve|doc:reject|run:mark|run:confirm|run:reject|run:invalidate|flow:init|flow:start)$/;
      if (!meaningful.test(event.type)) return;

      // 【修正 · 2026-11-25 严重】state:reset 是"整个 state 被替换"，
      // 它有两个来源：切本地任务（tasks.js）和载入服务器状态（本文件）。
      // 如果把它当成内容变更推上去，用户切一下本地任务就会把**别人的**任务内容
      // 写到共享项目里，覆盖掉当前真正的项目数据（实测确认这个覆盖链路存在）。
      // 正确做法：整体替换后不推送，只接受"局部改动"作为同步触发。
      if (!root.Collab || !root.Collab.isLoggedIn()) return;
      setMode('syncing');
      root.Collab.scheduleSave(function () { return Store.getState(); });
    });
  }

  root.CollabBoot = {
    boot: boot,
    status: function () { return { mode: state.mode, message: state.message }; },
    retry: function () { state.booted = false; boot(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
