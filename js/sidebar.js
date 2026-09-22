/*!
 * 流程智能体 —— 左侧栏 window.Sidebar（折叠 + 拖拽调宽 + 选项卡）
 * 纯浏览器 script（无 module / 无框架 / 无第三方依赖），file:// 双击 index.html 即可运行。
 *
 * ============================== 职责 ==============================
 *   #sidebar              折叠类 .sidebar-collapsed（CSS 收到 44px 细条，展开按钮仍可见）
 *   #sidebar-tabs         选项卡列表：按 state.tabs / state.activeTabId 重建内部节点
 *   #btn-sidebar-toggle   click -> Store.setSidebar({ collapsed: 取反 })
 *   #sidebar-resizer      拖拽调宽（pointerdown/move/up/cancel）；双击切换折叠
 *   :root --sidebar-w     侧栏宽度唯一开关（render 写；拖拽中每帧写，不落盘）
 *   #sidebar 末尾         .sidebar-hint 底部小字提示（只创建一次）
 *
 * ============================== 约定 ==============================
 *   - render() 内部自读 Store.getState()，不自行 subscribe（app.js 统一订阅并全量重渲染）
 *   - render() 幂等、可高频调用；静态节点只改属性 / class，绝不重建
 *   - 不使用 DOMContentLoaded：脚本位于 </body> 之前，加载期 DOM 已就绪，直接执行
 *   - 加载期不调用任何其它模块的 render()
 *
 * 宽度落盘策略：pointermove 中只写 --sidebar-w（跟手、不触发 Store 事件、不写 localStorage），
 *               pointerup / pointercancel 时才 Store.setSidebar({ width }) 落盘一次（内部夹取 180~520。
 */
;(function (root) {
  'use strict';

  var Store = root.Store;
  var doc = root.document;

  // 静态节点：加载期取一次；这些节点禁止重建，只允许改属性 / class（否则丢焦点与半截输入）
  var elSidebar = doc.getElementById('sidebar');
  var elToggle = doc.getElementById('btn-sidebar-toggle');
  var elTabs = doc.getElementById('sidebar-tabs');
  var elResizer = doc.getElementById('sidebar-resizer');

  if (!Store || !elSidebar || !elTabs) {
    if (root.console && root.console.error) {
      root.console.error('[Sidebar] 缺少 window.Store 或 #sidebar / #sidebar-tabs，左侧栏不可用');
    }
    // 仍挂上全局对象（app.js 会做存在性判断），避免整页因一个模块缺失而报错
    root.Sidebar = { render: function () {} };
    return;
  }

  var LIMITS = Store.LIMITS || {};
  var MIN_W = (typeof LIMITS.SIDEBAR_MIN === 'number') ? LIMITS.SIDEBAR_MIN : 180;
  var MAX_W = (typeof LIMITS.SIDEBAR_MAX === 'number') ? LIMITS.SIDEBAR_MAX : 520;
  var DEFAULT_W = (typeof LIMITS.SIDEBAR_DEFAULT === 'number') ? LIMITS.SIDEBAR_DEFAULT : 240;

  var HINT_TEXT = '流程智能体 · 演示版';
  var FLOW_BTN_TEXT = '按业务流程初始化 9 个模块';

  // 拖拽会话：active 为真时 render() 不写宽度（否则会与跟手值互相打架产生抖动）
  var drag = { active: false, pointerId: null, width: DEFAULT_W };
  // 选项卡渲染签名：内容没变时跳过重建，避免高频 render 做无谓 DOM 操作
  var tabsSig = '';

  // ------------------------------------------------------------- 工具

  /** 夹取到 [MIN_W, MAX_W] 的整数宽度；非法输入回默认值 */
  function clampWidth(value) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = DEFAULT_W;
    if (n < MIN_W) n = MIN_W;
    if (n > MAX_W) n = MAX_W;
    return n;
  }

  /** 侧栏宽度的唯一开关：写 :root 的 --sidebar-w（CSS 兜底 240px） */
  function applyWidthVar(width) {
    doc.documentElement.style.setProperty('--sidebar-w', width + 'px');
  }

  function addClass(el, name) {
    if (el && el.classList && !el.classList.contains(name)) el.classList.add(name);
  }

  function removeClass(el, name) {
    if (el && el.classList && el.classList.contains(name)) el.classList.remove(name);
  }

  // --------------------------------------------------------- 渲染各块

  /** 按 state.tabs / state.activeTabId 重建 #sidebar-tabs（该容器允许整体重建） */
  function renderTabs(state) {
    var tabs = state.tabs || [];
    var sig = String(state.activeTabId) + '|';
    var i;
    for (i = 0; i < tabs.length; i++) sig += tabs[i].id + ':' + tabs[i].name + ';';
    if (sig === tabsSig && elTabs.childNodes && elTabs.childNodes.length === tabs.length) return;

    var frag = doc.createDocumentFragment();
    for (i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var item = doc.createElement('div');
      var active = (tab.id === state.activeTabId);
      item.className = active ? 'sidebar-tab sidebar-tab-active' : 'sidebar-tab';
      item.setAttribute('data-id', tab.id);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.setAttribute('title', tab.name);
      item.textContent = tab.name;   // 一律 textContent 赋值，杜绝 HTML 拼接注入
      frag.appendChild(item);
    }
    elTabs.innerHTML = '';
    elTabs.appendChild(frag);
    tabsSig = sig;
  }

  var elFlowBtn = null;

  /**
   * 侧栏「按流程图初始化」按钮：只创建一次。
   * 放在侧栏（而非模块空间空状态）的原因：workspace.js 的 decorateSpace() 在无模块时会
   * replaceChildren 换掉 #module-space 的内容，放在那里的按钮会被覆盖掉。
   */
  function ensureFlowButton() {
    if (!elFlowBtn) {
      elFlowBtn = doc.createElement('button');
      elFlowBtn.type = 'button';
      elFlowBtn.className = 'sidebar-flow-btn';
      elFlowBtn.textContent = FLOW_BTN_TEXT;
      elFlowBtn.addEventListener('click', function () {
        if (Store && typeof Store.initFlowModules === 'function') Store.initFlowModules();
      });
      elSidebar.appendChild(elFlowBtn);   // 追加到 #sidebar 末尾
    }
    return elFlowBtn;
  }

  /** 侧栏底部小字提示：只创建一次，之后仅更新文案（折叠时 CSS 自动隐藏） */
  function ensureHint() {
    var hint = elSidebar.querySelector ? elSidebar.querySelector('.sidebar-hint') : null;
    if (!hint) {
      hint = doc.createElement('div');
      hint.className = 'sidebar-hint';
      elSidebar.appendChild(hint);   // 追加到 #sidebar 末尾
    }
    if (hint.textContent !== HINT_TEXT) hint.textContent = HINT_TEXT;
  }

  // ------------------------------------------------------------ render

  function render() {
    var state = Store.getState();
    var sb = state.sidebar || {};
    var collapsed = !!sb.collapsed;

    // 1) 宽度：唯一开关 —— 写 :root 的 --sidebar-w（拖拽中由指针逻辑实时接管）
    if (!drag.active) applyWidthVar(clampWidth(sb.width));

    // 2) 折叠态类加在 #sidebar 上（按钮只改属性，不重建）
    if (collapsed) addClass(elSidebar, 'sidebar-collapsed');
    else removeClass(elSidebar, 'sidebar-collapsed');

    if (elToggle) {
      elToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      elToggle.setAttribute('title', collapsed ? '展开侧栏' : '折叠侧栏');
    }

    // 3) 选项卡列表（state.tabs / state.activeTabId）
    renderTabs(state);

    // 4) 底部小字提示
    ensureHint();

    // 5) 流程初始化入口：按流程图缺几个模块就提示几个；9 个都齐了自动隐藏
    var flowBtn = ensureFlowButton();
    var have = {};
    var list = state.modules || [];
    for (var i = 0; i < list.length; i++) have[list[i].step] = true;
    var steps = (Store.FLOW_STEPS || []);
    var missing = 0;
    for (var j = 0; j < steps.length; j++) if (!have[steps[j].key]) missing += 1;
    flowBtn.hidden = missing === 0;
    var label = missing ? '按业务流程初始化 ' + missing + ' 个模块' : FLOW_BTN_TEXT;
    if (flowBtn.textContent !== label) flowBtn.textContent = label;
  }

  // ------------------------------------------------------------ 事件

  /** 折叠 / 展开：读当前值取反（回调里现读，避免用到过期闭包值） */
  function toggleCollapsed() {
    var sb = Store.getState().sidebar;
    Store.setSidebar({ collapsed: !sb.collapsed });
  }

  function onToggleClick() {
    toggleCollapsed();
  }

  /** 选项卡点击：事件委托（容器只在加载期绑一次，内容可随时重建） */
  function onTabsClick(e) {
    var target = e.target;
    var node = (target && target.closest) ? target.closest('.sidebar-tab') : null;
    if (!node || (elTabs.contains && !elTabs.contains(node))) return;
    var id = node.getAttribute('data-id');
    if (id) Store.selectTab(id);
  }

  function onResizerPointerDown(e) {
    if (drag.active) return;
    if (typeof e.button === 'number' && e.button !== 0) return;   // 只响应主键
    var sb = Store.getState().sidebar;
    if (sb.collapsed) return;                                     // 折叠态不响应拖拽

    drag.active = true;
    drag.pointerId = (typeof e.pointerId === 'number') ? e.pointerId : null;
    drag.width = clampWidth(sb.width);

    // 指针捕获：拖出 6px 手柄（甚至拖出窗口）仍能继续收到 pointermove
    if (elResizer.setPointerCapture && drag.pointerId !== null) {
      try { elResizer.setPointerCapture(drag.pointerId); } catch (err) { /* 无捕获也能靠 window 监听跟手 */ }
    }
    addClass(elResizer, 'is-active');
    addClass(doc.body, 'sidebar-resizing');   // CSS：禁过渡 / 禁选中 / col-resize 光标
    if (e.preventDefault) e.preventDefault();
  }

  function onWindowPointerMove(e) {
    if (!drag.active) return;
    if (drag.pointerId !== null && e.pointerId !== drag.pointerId) return;

    var left = elSidebar.getBoundingClientRect ? elSidebar.getBoundingClientRect().left : 0;
    drag.width = clampWidth(e.clientX - left);
    applyWidthVar(drag.width);   // 实时跟手：不落盘、不 emit
    if (e.preventDefault) e.preventDefault();
  }

  /** 结束拖拽：移除拖拽态类 + 落盘一次宽度（Store 只在真正变化时 emit） */
  function endDrag(e) {
    if (!drag.active) return;
    if (e && drag.pointerId !== null && typeof e.pointerId === 'number' && e.pointerId !== drag.pointerId) return;

    var pointerId = drag.pointerId;
    drag.active = false;
    drag.pointerId = null;

    if (elResizer.releasePointerCapture && pointerId !== null) {
      try { elResizer.releasePointerCapture(pointerId); } catch (err) { /* 指针已失效，忽略 */ }
    }
    removeClass(elResizer, 'is-active');
    removeClass(doc.body, 'sidebar-resizing');
    Store.setSidebar({ width: drag.width });
  }

  function onWindowPointerUp(e) { endDrag(e); }
  function onWindowPointerCancel(e) { endDrag(e); }

  /** 双击手柄：折叠 / 展开（折叠态手柄被 CSS 隐藏，不会触发） */
  function onResizerDblClick(e) {
    if (e && e.preventDefault) e.preventDefault();
    toggleCollapsed();
  }

  // 只在加载期绑定一次（含 window 级 pointermove/up/cancel，用 drag.active 守卫）
  if (elToggle) elToggle.addEventListener('click', onToggleClick);
  elTabs.addEventListener('click', onTabsClick);
  if (elResizer) {
    elResizer.addEventListener('pointerdown', onResizerPointerDown);
    elResizer.addEventListener('dblclick', onResizerDblClick);
  }
  root.addEventListener('pointermove', onWindowPointerMove);
  root.addEventListener('pointerup', onWindowPointerUp);
  root.addEventListener('pointercancel', onWindowPointerCancel);

  root.Sidebar = { render: render };
})(typeof window !== 'undefined' ? window : this);
