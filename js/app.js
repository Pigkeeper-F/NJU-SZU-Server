/*!
 * 流程智能体 —— 装配层 window.App（T5 交付）
 * 纯浏览器 script（零依赖 / 无 module / 无 fetch / 无 CDN），file:// 双击 index.html 即可运行。
 *
 * ============================== 职责 ==============================
 *  1) 首次渲染：确保默认选项卡被选中（Store.selectTab('flow')）后全量渲染一次；
 *  2) 订阅调度：Store.subscribe(evt => 全量重渲染)，任何状态变更由本层统一扇出到三个 UI 模块；
 *  3) 存在性守卫：window.Sidebar / ModuleTabs / ModuleSpace 任一缺失只 console.warn 并跳过，
 *     绝不因单个模块缺失让整页报错；单个 render() 抛错也不会波及其它模块；
 *  4) 数据层缺失（window.Store 不存在或签名不全）时给出**页面顶部可见提示** + console.error。
 *
 * ============================ 渲染顺序（固定） ============================
 *   window.Sidebar.render()      // ① 先侧栏：写 --sidebar-w / 折叠类（宽度会影响主区布局）
 *   window.ModuleTabs.render()   // ② 再顶部模块选项卡条（含 #module-chain 依赖链概览）
 *   window.ModuleSpace.render()  // ③ 再模块独立空间 + 底部输入区
 *
 * 说明：本文件不含任何业务状态；所有状态读写都经由 window.Store 的 API。
 *      三个 UI 模块各自在 render() 内自读 Store.getState()，不自行 subscribe（见 docs/contract.md §7）。
 */
;(function (root) {
  'use strict';

  var doc = root.document;
  var RENDER_ORDER = ['Sidebar', 'ModuleTabs', 'ModuleSpace'];

  /**
   * 页面顶部可见的致命错误条（只创建一次，之后仅更新文案）。
   * 用内联样式而非新增 CSS 类：css/style.css 归 T1 维护，装配层不擅自扩样式表。
   */
  function showFatal(message) {
    try {
      if (!doc || !doc.body) return;
      var box = doc.getElementById('app-error');
      if (!box) {
        box = doc.createElement('div');
        box.id = 'app-error';
        box.setAttribute('role', 'alert');
        box.setAttribute('style',
          'position:fixed;top:0;left:0;right:0;z-index:9999;padding:9px 14px;' +
          'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
          'color:#fff;background:#e5484d;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25)');
        if (doc.body.firstChild) doc.body.insertBefore(box, doc.body.firstChild);
        else doc.body.appendChild(box);
      }
      box.textContent = message;
    } catch (e) {
      /* 提示条本身失败不影响后续流程 */
    }
  }

  /** 取某个 UI 模块的 render；不存在或不是函数 -> console.warn 并返回 null（跳过，不报错） */
  function pickRenderer(name) {
    var mod = root[name];
    if (mod && typeof mod.render === 'function') return mod.render;
    if (root.console && root.console.warn) {
      root.console.warn('[App] 缺少 window.' + name + ' 或其 render()，已跳过该模块的渲染');
    }
    return null;
  }

  /** 全量重渲染：固定顺序 + 单模块异常隔离（某个 render 抛错不影响另外两个） */
  function renderAll() {
    for (var i = 0; i < RENDER_ORDER.length; i++) {
      var name = RENDER_ORDER[i];
      var render = pickRenderer(name);
      if (!render) continue;
      try {
        render();
      } catch (e) {
        if (root.console && root.console.error) {
          root.console.error('[App] window.' + name + '.render() 抛出异常（已隔离）:', e);
        }
      }
    }
  }

  /** 启动：默认选项卡兜底 + 首次渲染 + 订阅调度 */
  function boot() {
    var Store = root.Store;
    if (!Store || typeof Store.getState !== 'function' || typeof Store.subscribe !== 'function') {
      showFatal('流程智能体：数据层 js/store.js 未加载（window.Store 缺失），界面无法工作。' +
        '请确认 index.html 的脚本顺序为 store.js → sidebar.js → tabs.js → chat.js → app.js。');
      if (root.console && root.console.error) {
        root.console.error('[App] window.Store 缺失或签名不全，装配中止（window.App 仍已挂载）');
      }
      return;
    }

    // ① 默认选项卡兜底选中：优先 'flow'；state.tabs 里没有它时退回第一个选项卡（防御脏数据）
    var state = Store.getState() || {};
    var tabs = state.tabs || [];
    var targetId = null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i] && tabs[i].id === 'flow') { targetId = 'flow'; break; }
    }
    if (!targetId && tabs.length) targetId = tabs[0].id;
    if (targetId && state.activeTabId !== targetId) Store.selectTab(targetId);

    // ② 首次全量渲染（此时 window.Sidebar / ModuleTabs / ModuleSpace 应已由各自脚本挂载）
    renderAll();

    // ③ 任何状态变更 -> 全量重渲染（各 render() 幂等、可高频调用；Store 内部已捕获订阅者异常）
    Store.subscribe(function (evt) {
      if (!evt) return;
      if (root.console && root.console.debug) root.console.debug('[event]', evt.type, evt.payload);
      renderAll();
    });

    if (root.console && root.console.debug) {
      root.console.debug('[App] 装配完成：渲染顺序 ' + RENDER_ORDER.join(' → '));
    }
  }

  // 先挂载 window.App（即使 boot 抛错，调试入口仍在），再启动
  root.App = { render: renderAll, renderAll: renderAll };

  try {
    boot();
  } catch (e) {
    showFatal('流程智能体：启动失败，详见控制台错误信息。');
    if (root.console && root.console.error) root.console.error('[App] 启动异常:', e);
  }
})(typeof window !== 'undefined' ? window : this);
