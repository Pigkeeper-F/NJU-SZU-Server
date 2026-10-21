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
  var FLOW_BTN_TEXT = '按业务流程开始（九步研究流程）';

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
        if (!Store) return;
        var state = Store.getState ? Store.getState() : null;
        var modules = (state && state.modules) ? state.modules : [];
        // 当前任务已经有流程链时不再往里塞九步链（两条链混在一起会看不清），
        // 直接告诉使用者去新建一个空任务。
        if (modules.length) {
          if (root.alert) {
            root.alert('当前任务已有流程链（' + modules.length + ' 个模块）。九步研究流程要放在一个空任务里：点顶部「+ 新建任务」，再点这个按钮。');
          }
          return;
        }
        // 逐步解锁：只建第①步（文献调研），之后每过一个审核门自动补出下一个。
        if (typeof Store.startFlow === 'function') Store.startFlow();
        else if (typeof Store.initFlowModules === 'function') Store.initFlowModules();
      });
      // 插在底部工具区（＋添加 API / ✎编辑依赖）之前，而不是追加到最末尾——
      // 追加会跑到「个人工作空间」下面，既不显眼也不合布局。
      var footer = elSidebar.querySelector ? elSidebar.querySelector('.sidebar-footer') : null;
      if (footer && footer.parentNode === elSidebar) elSidebar.insertBefore(elFlowBtn, footer);
      else elSidebar.appendChild(elFlowBtn);
    }
    return elFlowBtn;
  }

  /** 侧栏底部小字提示：只创建一次，之后仅更新文案（折叠时 CSS 自动隐藏） */
  /** 侧栏底部的「调试台」小链接：打开独立的调试页（请求记录 / 错误 / 当前模型） */
  function ensureDebugLink() {
    var link = elSidebar.querySelector ? elSidebar.querySelector('.sidebar-debug-link') : null;
    if (link) return link;
    var box = doc.createElement('a');
    box.className = 'sidebar-debug-link';
    box.href = 'debug.html';
    box.textContent = '调试台';
    box.title = '查看服务端请求记录与错误';
    elSidebar.appendChild(box);
    return box;
  }

  function ensureHint() {
    var hint = elSidebar.querySelector ? elSidebar.querySelector('.sidebar-hint') : null;
    if (!hint) {
      hint = doc.createElement('div');
      hint.className = 'sidebar-hint';
      elSidebar.appendChild(hint);   // 追加到 #sidebar 末尾
    }
    if (hint.textContent !== HINT_TEXT) hint.textContent = HINT_TEXT;
  }

  // ---------------------------------------------- 项目管理（新建 / 历史切换）

  var elProjectPanel = null;
  var elProjectInput = null;

  /** 新建项目输入条（默认隐藏；Enter 确定、Esc 取消） */
  function buildNewProjectBar() {
    var bar = doc.createElement('div');
    bar.className = 'project-new-bar';
    bar.hidden = true;

    elProjectInput = doc.createElement('input');
    elProjectInput.type = 'text';
    elProjectInput.className = 'project-new-input';
    elProjectInput.placeholder = '新项目名称';
    elProjectInput.maxLength = 80; // 与「修改项目名称」对话框的 maxlength 保持一致

    var ok = doc.createElement('button');
    ok.type = 'button';
    ok.className = 'project-new-ok';
    ok.textContent = '确定';

    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'project-new-cancel';
    cancel.textContent = '取消';

    function submitNewProject() {
      if (!Store || typeof Store.createProject !== 'function') return;
      var result = Store.createProject(elProjectInput.value);
      // createProject 会先把当前工作区归档进历史，不会丢数据；项目名存在 workspace 的 meta 键里，
      // 刷新一次让侧栏/详情/标题处的项目名一致。
      if (result && result.ok) { location.reload(); return; }
      elProjectInput.focus();
    }

    ok.addEventListener('click', submitNewProject);
    elProjectInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitNewProject(); }
      else if (e.key === 'Escape') { bar.hidden = true; }
    });
    cancel.addEventListener('click', function () { bar.hidden = true; });

    bar.appendChild(elProjectInput);
    bar.appendChild(ok);
    bar.appendChild(cancel);
    return bar;
  }

  /** 项目管理区（新建输入条 + 历史项目列表）：只创建一次，插在「当前项目」卡片之后 */
  function ensureProjectPanel() {
    if (elProjectPanel) return elProjectPanel;
    elProjectPanel = doc.createElement('div');
    elProjectPanel.className = 'sidebar-projects';
    elProjectPanel.appendChild(buildNewProjectBar());
    var history = doc.createElement('div');
    history.className = 'project-history';
    elProjectPanel.appendChild(history);

    var anchor = elSidebar.querySelector ? elSidebar.querySelector('#project-shortcut') : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(elProjectPanel, anchor.nextSibling);
    else elSidebar.appendChild(elProjectPanel);
    return elProjectPanel;
  }

  /** 「当前项目」文字右侧的 + 按钮 */
  function ensureProjectAdd() {
    var label = elSidebar.querySelector ? elSidebar.querySelector('.project-label') : null;
    if (!label || label.querySelector('.project-add-btn')) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'project-add-btn';
    btn.textContent = '+';
    btn.title = '新建项目';
    btn.setAttribute('aria-label', '新建项目');
    btn.addEventListener('click', function () {
      var panel = ensureProjectPanel();
      var bar = panel.querySelector('.project-new-bar');
      bar.hidden = !bar.hidden;
      if (!bar.hidden) { elProjectInput.value = ''; elProjectInput.focus(); }
    });
    label.appendChild(btn);
  }

  // -------------------------------------------- 项目右键菜单（删除）

  var elProjMenu = null;

  function closeProjectMenu() {
    if (elProjMenu && elProjMenu.parentNode) elProjMenu.parentNode.removeChild(elProjMenu);
    elProjMenu = null;
  }

  /** 在鼠标位置弹出项目菜单；只做「删除」，删当前项目时会自动切到剩下的项目 */
  function openProjectMenu(x, y, project) {
    closeProjectMenu();
    var menu = doc.createElement('div');
    menu.className = 'proj-menu';
    menu.setAttribute('role', 'menu');

    var del = doc.createElement('button');
    del.type = 'button';
    del.className = 'proj-menu-item proj-menu-danger';
    del.setAttribute('role', 'menuitem');
    del.textContent = '删除项目';
    del.addEventListener('click', function (event) {
      event.stopPropagation();
      closeProjectMenu();
      var msg = project.isCurrent
        ? '删除当前项目「' + project.name + '」？删掉后会自动切到列表里剩下的第一个项目；一个都不剩时会新建一个空项目。'
        : '删除项目「' + project.name + '」（' + project.moduleCount + ' 个模块）？删除后无法恢复。';
      if (root.confirm && !root.confirm(msg)) return;
      var r = Store.deleteProject(project.id);
      if (r && r.ok) { root.location.reload(); return; }
      if (root.alert) root.alert((r && r.reason) || '删除失败');
    });
    menu.appendChild(del);

    menu.style.left = '0px';
    menu.style.top = '0px';
    doc.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    var maxX = (root.innerWidth || 9999) - rect.width - 8;
    var maxY = (root.innerHeight || 9999) - rect.height - 8;
    menu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
    elProjMenu = menu;
  }

  /** 点空白处 / 滚动 / Esc 关掉菜单（加载期只绑一次） */
  doc.addEventListener('click', function () { closeProjectMenu(); });
  doc.addEventListener('contextmenu', function (event) {
    if (elProjMenu && !elProjMenu.contains(event.target)) closeProjectMenu();
  }, true);
  root.addEventListener('scroll', function () { closeProjectMenu(); }, true);
  doc.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeProjectMenu();
  });

  // -------------------------------------------- 模型设置（左下角齿轮）

  var elSettingsBtn = null;
  var elSettingsDialog = null;
  var elModelMenu = null;       // ▼ 模型列表弹层（构建时缓存）
  var elModelPicker = null;     // 模型选择器容器（用于判断"点击落在外部"）
  var settingsNorm = null;      // 当前表单对应的规范化设置（v2；各处理器共用）

  /** 读取本机保存的模型设置（v2 规范化；无配置返回空分组结构） */
  function readLlmSettings() {
    var api = root.Store && root.Store.llmSettings;
    return api ? api.read() : { version: 2, activeGroupId: '', groups: [] };
  }

  /** 写回模型设置（规范化由 Store.llmSettings.write 内做） */
  function saveLlmSettings(norm) {
    var api = root.Store && root.Store.llmSettings;
    return api ? api.write(norm) : false;
  }

  function settingsField(labelText, id, placeholder, type) {
    var wrap = doc.createElement('label');
    wrap.className = 'settings-field';
    var cap = doc.createElement('span');
    cap.textContent = labelText;
    var input = doc.createElement('input');
    input.type = type || 'text';
    input.id = id;
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.appendChild(cap);
    wrap.appendChild(input);
    return wrap;
  }

  /** 左下角齿轮：只创建一次 */
  function ensureSettingsButton() {
    if (elSettingsBtn) return elSettingsBtn;
    elSettingsBtn = doc.createElement('button');
    elSettingsBtn.type = 'button';
    elSettingsBtn.className = 'sidebar-gear-btn';
    elSettingsBtn.title = '设置';
    elSettingsBtn.setAttribute('aria-label', '设置');
    elSettingsBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'd="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/>' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'd="M19.4 13.5a1 1 0 0 0 .2 1.1l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.3a1.7 1.7 0 1 1-3.4 0v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.3a1.7 1.7 0 1 1 0-3.4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9v-.3a1.7 1.7 0 1 1 3.4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.3a1.7 1.7 0 1 1 0 3.4h-.2a1 1 0 0 0-.9.6Z"/>' +
      '</svg>';
    elSettingsBtn.addEventListener('click', openSettingsDialog);
    var bottom = elSidebar.querySelector ? elSidebar.querySelector('.sidebar-bottom') : null;
    if (bottom) bottom.appendChild(elSettingsBtn);
    else elSidebar.appendChild(elSettingsBtn);
    return elSettingsBtn;
  }

  function buildSettingsDialog() {
    var dlg = doc.createElement('dialog');
    dlg.className = 'settings-dialog';
    dlg.id = 'llm-settings-dialog';

    var form = doc.createElement('form');
    form.method = 'dialog';

    /* ---------------- 头部 ---------------- */
    var head = doc.createElement('div');
    head.className = 'settings-head';
    var title = doc.createElement('h2');
    title.textContent = '设置';
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', function () { dlg.close(); });
    head.appendChild(title);
    head.appendChild(close);

    /* -------- 两栏：左「选项栏」 + 右内容区 -------- */
    var layout = doc.createElement('div');
    layout.className = 'settings-layout';

    var nav = doc.createElement('nav');
    nav.className = 'settings-nav';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', '设置分类');
    [['model', '模型'], ['about', '关于']].forEach(function (pair) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-nav-item' + (pair[0] === 'model' ? ' is-active' : '');
      btn.textContent = pair[1];
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-settings-tab', pair[0]);
      btn.addEventListener('click', function () { activateSettingsTab(pair[0]); });
      nav.appendChild(btn);
    });

    var panes = doc.createElement('div');
    panes.className = 'settings-panes';

    /* ---------------- 模型 ---------------- */
    var modelPane = doc.createElement('div');
    modelPane.className = 'settings-pane is-active';
    modelPane.setAttribute('data-settings-pane', 'model');

    var body = doc.createElement('div');
    body.className = 'settings-body';

    // 【模型分组 · 2026-10-15】一个地址 + 一个 Key = 一个分组；切换/新建/删除都在这一行
    var groupWrap = doc.createElement('label');
    groupWrap.className = 'settings-field';
    var groupCap = doc.createElement('span');
    groupCap.textContent = '分组（一个地址 + 一个 Key 为一组）';
    var groupRow = doc.createElement('div');
    groupRow.className = 'settings-group-row';
    var groupSel = doc.createElement('select');
    groupSel.id = 'llm-group-select';
    groupSel.setAttribute('aria-label', '模型分组');
    groupSel.addEventListener('change', function () { switchSettingsGroup(groupSel.value); });
    var groupAdd = doc.createElement('button');
    groupAdd.type = 'button';
    groupAdd.id = 'llm-group-add';
    groupAdd.className = 'quiet-button';
    groupAdd.textContent = '＋ 新建分组';
    groupAdd.addEventListener('click', addSettingsGroup);
    var groupDel = doc.createElement('button');
    groupDel.type = 'button';
    groupDel.id = 'llm-group-remove';
    groupDel.className = 'quiet-button';
    groupDel.textContent = '删除当前分组';
    groupDel.addEventListener('click', removeSettingsGroup);
    groupRow.appendChild(groupSel);
    groupRow.appendChild(groupAdd);
    groupRow.appendChild(groupDel);
    groupWrap.appendChild(groupCap);
    groupWrap.appendChild(groupRow);
    body.appendChild(groupWrap);

    body.appendChild(settingsField('接口地址（Base URL）', 'llm-base-url',
      '例如 https://api.commandcode.ai/provider/v1'));

    // 【模型分组 · 2026-10-15】模型名左侧 ▼ 展开本组模型列表（点选即填入；保存时自动并入列表）
    var modelWrap = doc.createElement('label');
    modelWrap.className = 'settings-field';
    var modelCap = doc.createElement('span');
    modelCap.textContent = '模型名（左侧 ▼ 显示本组模型列表）';
    var picker = doc.createElement('div');
    picker.className = 'model-picker';
    var modelToggle = doc.createElement('button');
    modelToggle.type = 'button';
    modelToggle.id = 'llm-model-toggle';
    modelToggle.className = 'model-caret-btn';
    modelToggle.textContent = '▼';
    modelToggle.title = '模型列表';
    modelToggle.setAttribute('aria-label', '模型列表');
    modelToggle.addEventListener('click', toggleModelMenu);
    var modelInput = doc.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'llm-model';
    modelInput.placeholder = '例如 deepseek/deepseek-v4-flash';
    modelInput.autocomplete = 'off';
    modelInput.spellcheck = false;
    var modelMenu = doc.createElement('div');
    modelMenu.className = 'model-menu';
    modelMenu.id = 'llm-model-menu';
    picker.appendChild(modelToggle);
    picker.appendChild(modelInput);
    picker.appendChild(modelMenu);
    modelWrap.appendChild(modelCap);
    modelWrap.appendChild(picker);
    body.appendChild(modelWrap);
    elModelPicker = picker;
    elModelMenu = modelMenu;

    var proto = doc.createElement('label');
    proto.className = 'settings-field';
    var pcap = doc.createElement('span');
    pcap.textContent = '协议';
    var sel = doc.createElement('select');
    sel.id = 'llm-protocol';
    [['chat-completions', 'chat-completions（多数兼容服务用这个）'],
     ['responses', 'responses（OpenAI Responses API）']].forEach(function (pair) {
      var opt = doc.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      sel.appendChild(opt);
    });
    proto.appendChild(pcap);
    proto.appendChild(sel);
    body.appendChild(proto);

    body.appendChild(settingsField('API Key', 'llm-api-key', 'sk-…', 'password'));

    // 【体验升级 · 2026-10-13】系统提示词（可选）：随请求发到本机服务，注入为 system 指令
    var sysWrap = doc.createElement('label');
    sysWrap.className = 'settings-field';
    var sysCap = doc.createElement('span');
    sysCap.textContent = '系统提示词（可选）';
    var sysInput = doc.createElement('textarea');
    sysInput.id = 'llm-system-prompt';
    sysInput.rows = 3;
    sysInput.maxLength = 2000;
    sysInput.placeholder = '例如：你是科研写作助手，回答尽量简洁、给出可核查的依据。';
    sysWrap.appendChild(sysCap);
    sysWrap.appendChild(sysInput);
    body.appendChild(sysWrap);

    var hint = doc.createElement('p');
    hint.className = 'settings-hint';
    hint.textContent = '留空则使用服务端 .env 里已配置的模型。密钥只保存在本机浏览器，' +
      '只会发给你本机跑的这个服务，不会出现在页面别处。';
    body.appendChild(hint);

    var status = doc.createElement('p');
    status.className = 'settings-status';
    status.id = 'llm-settings-status';
    body.appendChild(status);
    modelPane.appendChild(body);

    var actions = doc.createElement('div');
    actions.className = 'settings-actions';
    // 【模型分组 · 2026-10-15】测试连通：用表单当前值（未保存也生效；留空回落 .env）走同源 /api/ai/test
    var testBtn = doc.createElement('button');
    testBtn.type = 'button';
    testBtn.id = 'llm-test-btn';
    testBtn.className = 'quiet-button';
    testBtn.textContent = '测试连通';
    testBtn.addEventListener('click', testSettingsConnection);
    var save = doc.createElement('button');
    save.type = 'submit';
    save.className = 'primary-button';
    save.textContent = '保存';
    var clear = doc.createElement('button');
    clear.type = 'button';
    clear.className = 'quiet-button';
    clear.textContent = '清除';
    clear.addEventListener('click', function () {
      if (root.Store && root.Store.llmSettings) root.Store.llmSettings.clear();
      fillSettingsForm();
      closeModelMenu();
      setSettingsStatus('已清除本机保存的模型设置（全部分组），将使用服务端 .env 的配置。', true);
    });
    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'quiet-button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () { dlg.close(); });
    actions.appendChild(testBtn);
    actions.appendChild(save);
    actions.appendChild(clear);
    actions.appendChild(cancel);
    modelPane.appendChild(actions);

    /* ---------------- 关于 ---------------- */
    var aboutPane = doc.createElement('div');
    aboutPane.className = 'settings-pane';
    aboutPane.setAttribute('data-settings-pane', 'about');

    panes.appendChild(modelPane);
    panes.appendChild(aboutPane);
    layout.appendChild(nav);
    layout.appendChild(panes);

    form.appendChild(head);
    form.appendChild(layout);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var ok = persistSettingsForm();
      setSettingsStatus(ok ? '已保存。下一次发送就会使用这套配置。'
                           : '保存失败：浏览器本地存储不可用。', ok);
    });
    dlg.appendChild(form);
    doc.body.appendChild(dlg);
    return dlg;
  }

  /** 切换设置里的选项卡（左「选项栏」-> 右内容区） */
  function activateSettingsTab(key) {
    var dlg = elSettingsDialog || doc.getElementById('llm-settings-dialog');
    if (!dlg) return;
    var items = dlg.querySelectorAll('.settings-nav-item');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-settings-tab') === key;
      items[i].className = 'settings-nav-item' + (on ? ' is-active' : '');
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = dlg.querySelectorAll('.settings-pane');
    for (var j = 0; j < panes.length; j++) {
      var show = panes[j].getAttribute('data-settings-pane') === key;
      panes[j].className = 'settings-pane' + (show ? ' is-active' : '');
    }
    dlg.setAttribute('data-active-tab', key);
    if (key === 'about') renderAboutPane(dlg.querySelector('[data-settings-pane="about"]'));
  }

  /** 「关于」页：版本 / 项目数 / 本地存储用量（只读，不做任何写操作） */
  function renderAboutPane(pane) {
    if (!pane) return;
    pane.innerHTML = '';

    var keys = ['fa_state_v1', 'fa_projects_v1', 'research_workspace_meta_v1',
                'fa_current_project_id_v1', 'fa_llm_settings_v1'];
    var used = 0, bytes = 0;
    for (var i = 0; i < keys.length; i++) {
      var raw = null;
      try { raw = root.localStorage ? root.localStorage.getItem(keys[i]) : null; } catch (e) { raw = null; }
      if (raw) { used += 1; bytes += raw.length; }
    }
    var projects = 0;
    try {
      projects = (Store && typeof Store.listProjects === 'function') ? Store.listProjects().length : 0;
    } catch (e) { projects = 0; }

    var list = doc.createElement('dl');
    list.className = 'settings-about';
    function row(k, v, mono) {
      var dt = doc.createElement('dt');
      dt.textContent = k;
      var dd = doc.createElement('dd');
      if (mono) dd.className = 'mono';
      dd.textContent = v;
      list.appendChild(dt);
      list.appendChild(dd);
    }
    row('版本', '2026-10-13 修复 · 账号 · 体验版');
    row('项目数', projects + ' 个');
    row('本地存储', used + ' / ' + keys.length + ' 个键，约 ' + Math.round(bytes / 1024) + ' KB');
    row('数据位置', '本机浏览器 localStorage（换浏览器或清缓存会丢）');
    row('访问地址', String(root.location && root.location.origin ? root.location.origin : 'file://'));
    pane.appendChild(list);

    var tip = doc.createElement('p');
    tip.className = 'settings-hint';
    tip.textContent = '模型配置在「模型」页；留空的字段会回落到服务端 .env。';
    pane.appendChild(tip);
  }

  /** 在对话框里显示一行状态（不用 alert：会阻塞页面） */
  function setSettingsStatus(text, ok) {
    var el = doc.getElementById('llm-settings-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'settings-status' + (ok === undefined ? '' : (ok ? ' is-ok' : ' is-error'));
  }

  function fillSettingsForm() {
    settingsNorm = settingsNormForForm();
    renderSettingsGroupSelect();
    fillSettingsFields();
    renderModelMenu();
  }

  /** 取规范化设置；无分组时创建一个内存草稿分组（不落盘，点「保存」才写入） */
  function settingsNormForForm() {
    var norm = readLlmSettings();
    var api = root.Store && root.Store.llmSettings;
    if (api) {
      if (!norm.groups.length) api.addGroup(norm, '分组 1');
      if (!api.activeGroup(norm)) norm.activeGroupId = norm.groups[0].id;
    }
    return norm;
  }

  function activeSettingsGroup() {
    var api = root.Store && root.Store.llmSettings;
    return (api && settingsNorm) ? api.activeGroup(settingsNorm) : null;
  }

  function setFieldValue(id, value) {
    var el = doc.getElementById(id);
    if (el) el.value = value || '';
  }

  function fieldValue(id) {
    var el = doc.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  /** 分组下拉：选项 = 各分组名（缺名按序号），选中 = 激活分组 */
  function renderSettingsGroupSelect() {
    var sel = doc.getElementById('llm-group-select');
    if (!sel || !settingsNorm) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    settingsNorm.groups.forEach(function (group, index) {
      var opt = doc.createElement('option');
      opt.value = group.id;
      opt.textContent = group.name || ('分组 ' + (index + 1));
      sel.appendChild(opt);
    });
    sel.value = settingsNorm.activeGroupId;
  }

  function fillSettingsFields() {
    var group = activeSettingsGroup() || {};
    setFieldValue('llm-base-url', group.baseUrl);
    setFieldValue('llm-model', group.model);
    setFieldValue('llm-api-key', group.apiKey);
    setFieldValue('llm-protocol', group.protocol || 'chat-completions');
    setFieldValue('llm-system-prompt', group.systemPrompt);
  }

  /** 把当前表单落盘到激活分组（model 由 Store 自动并入 models 列表） */
  function persistSettingsForm() {
    var api = root.Store && root.Store.llmSettings;
    if (!api || !settingsNorm) return false;
    var updated = api.updateGroup(settingsNorm, settingsNorm.activeGroupId, {
      baseUrl: fieldValue('llm-base-url'),
      model: fieldValue('llm-model'),
      protocol: fieldValue('llm-protocol'),
      apiKey: fieldValue('llm-api-key'),
      systemPrompt: fieldValue('llm-system-prompt')
    });
    if (!updated) return false;
    var ok = saveLlmSettings(settingsNorm);
    renderModelMenu();
    return ok;
  }

  /** 「测试连通」：用表单当前值（未保存也生效；留空字段省略 → 回落服务端 .env）探测模型端点 */
  function testSettingsConnection() {
    var btn = doc.getElementById('llm-test-btn');
    var settings = {};
    var baseUrl = fieldValue('llm-base-url');
    var model = fieldValue('llm-model');
    var apiKey = fieldValue('llm-api-key');
    var protocol = fieldValue('llm-protocol');
    if (baseUrl) settings.baseUrl = baseUrl;
    if (model) settings.model = model;
    if (apiKey) settings.apiKey = apiKey;
    if (protocol) settings.protocol = protocol;
    var started = Date.now();
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    setSettingsStatus('正在测试连通…（留空字段将回落服务端 .env）', undefined);
    fetch('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
        return data;
      });
    }).then(function (data) {
      var line = '✓ 连通成功（' + (Date.now() - started) + ' ms' + (data.model ? '，模型 ' + data.model : '') + '）';
      if (data.reply) line += '：' + data.reply;
      setSettingsStatus(line + '。点「保存」后即用于对话。', true);
    }).catch(function (error) {
      setSettingsStatus('✗ 连接失败：' + (error && error.message ? error.message : '未知错误'), false);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = '测试连通'; }
    });
  }

  /** 切换分组：先把当前表单静默落盘，再切到目标分组 */
  function switchSettingsGroup(groupId) {
    if (!settingsNorm || !groupId) return;
    persistSettingsForm();
    settingsNorm.activeGroupId = groupId;
    saveLlmSettings(settingsNorm);
    fillSettingsForm();
  }

  /** ＋ 新建分组：先落盘当前表单，再追加空分组并聚焦到地址输入 */
  function addSettingsGroup() {
    var api = root.Store && root.Store.llmSettings;
    if (!api || !settingsNorm) return;
    persistSettingsForm();
    api.addGroup(settingsNorm, '');
    saveLlmSettings(settingsNorm);
    fillSettingsForm();
    setSettingsStatus('已新建分组，填写地址与 Key 后点「保存」。', true);
    var input = doc.getElementById('llm-base-url');
    if (input && typeof input.focus === 'function') input.focus();
  }

  /** 删除当前分组（只剩 1 个时拒绝；先落盘再删，需确认） */
  function removeSettingsGroup() {
    var api = root.Store && root.Store.llmSettings;
    if (!api || !settingsNorm) return;
    if (settingsNorm.groups.length <= 1) {
      setSettingsStatus('只剩一个分组时不能删除；可用「清除」恢复默认配置。', false);
      return;
    }
    persistSettingsForm();
    var group = api.activeGroup(settingsNorm);
    if (root.confirm && !root.confirm('删除分组「' + ((group && group.name) || '') + '」（其地址与 Key 一并删除）？')) return;
    if (!api.removeGroup(settingsNorm, settingsNorm.activeGroupId)) return;
    saveLlmSettings(settingsNorm);
    fillSettingsForm();
    setSettingsStatus('已删除分组。', true);
  }

  /** 渲染 ▼ 弹层内容：当前分组的模型列表（空列表给提示；点选填入模型名） */
  function renderModelMenu() {
    if (!elModelMenu) return;
    while (elModelMenu.firstChild) elModelMenu.removeChild(elModelMenu.firstChild);
    var group = activeSettingsGroup();
    var models = (group && group.models) ? group.models : [];
    var current = (group && group.model) || '';
    if (!models.length) {
      var empty = doc.createElement('div');
      empty.className = 'model-menu-empty';
      empty.textContent = '暂无已保存模型：直接输入模型名后点「保存」，即会加入本组列表。';
      elModelMenu.appendChild(empty);
      return;
    }
    models.forEach(function (model) {
      var item = doc.createElement('button');
      item.type = 'button';
      item.className = 'model-menu-item' + (model === current ? ' is-active' : '');
      item.textContent = model + (model === current ? '（当前）' : '');
      item.addEventListener('click', function () {
        setFieldValue('llm-model', model);
        closeModelMenu();
      });
      elModelMenu.appendChild(item);
    });
  }

  function toggleModelMenu() {
    if (!elModelMenu) return;
    if (elModelMenu.classList.contains('is-open')) { closeModelMenu(); return; }
    renderModelMenu();
    elModelMenu.classList.add('is-open');
  }

  function closeModelMenu() {
    if (elModelMenu) elModelMenu.classList.remove('is-open');
  }

  // 点击选择器外部 / 按 Esc 收起模型列表（加载期只绑一次）
  doc.addEventListener('click', function (event) {
    if (elModelMenu && elModelPicker && !elModelPicker.contains(event.target)) closeModelMenu();
  });
  doc.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeModelMenu();
  });

  function openSettingsDialog() {
    if (!elSettingsDialog) {
      elSettingsDialog = buildSettingsDialog();
      elSettingsDialog.addEventListener('click', function (event) {
        if (event.target === elSettingsDialog) elSettingsDialog.close();
      });
    }
    fillSettingsForm();
    closeModelMenu();
    setSettingsStatus('', undefined);
    activateSettingsTab('model');          // 每次打开回到「模型」页
    if (typeof elSettingsDialog.showModal === 'function') elSettingsDialog.showModal();
    else elSettingsDialog.setAttribute('open', '');
    if (doc.getElementById('llm-base-url')) doc.getElementById('llm-base-url').focus();
  }

  /**
   * 项目列表：列出**全部**项目（含当前），点非当前项即切换。
   * 【本地修复 · 2026-09-24】原来列表只显示「非当前项目」（打开一个就把它从列表里删掉），
   * 空项目被打开时旧项目又不会被写回，用户看到「点过往的项目，那个项目就消失」。
   * 现在当前项目也显示在列表里并标「当前」，条目只增不减。
   */
  function renderProjectHistory() {
    var panel = ensureProjectPanel();
    var box = panel.querySelector('.project-history');
    if (!box || !Store || typeof Store.listProjects !== 'function') return;
    var list = Store.listProjects();
    box.innerHTML = '';
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    var head = doc.createElement('div');
    head.className = 'project-history-head';
    head.textContent = '项目 (' + list.length + ')';
    box.appendChild(head);
    for (var i = 0; i < list.length; i++) {
      (function (p) {
        var label = p.name + '（' + p.moduleCount + ' 模块）';
        if (p.isCurrent) {
          var now = doc.createElement('div');
          now.className = 'project-history-item is-current';
          now.appendChild(doc.createTextNode(label));
          var tag = doc.createElement('span');
          tag.className = 'project-history-tag';
          tag.textContent = '当前';
          now.appendChild(tag);
          now.title = '当前正在编辑的项目（右键可删除）';
          now.addEventListener('contextmenu', function (event) {
            event.preventDefault();
            openProjectMenu(event.clientX, event.clientY, p);
          });
          box.appendChild(now);
          return;
        }
        var item = doc.createElement('button');
        item.type = 'button';
        item.className = 'project-history-item';
        item.textContent = label;
        item.title = '左键打开（当前项目会自动保存）· 右键可删除';
        item.addEventListener('click', function () {
          var r = Store.openProject(p.id);
          if (r && r.ok) location.reload();
        });
        item.addEventListener('contextmenu', function (event) {
          event.preventDefault();
          openProjectMenu(event.clientX, event.clientY, p);
        });
        box.appendChild(item);
      })(list[i]);
    }
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

    // 4.5) 调试台入口：独立页面（/debug.html），不进主界面布局，出问题时有地方看日志。
    ensureDebugLink();

    // 5) 侧栏「按业务流程初始化 9 个模块」按钮：九步研究流程的入口。
    //    历史上这个入口被移除过、只留在"空模块空间"里，找入口很费劲（2026-10-21 放回侧栏）。
    ensureFlowButton();

    // 本工作台使用独立研究任务（js/tasks.js）；旧版项目列表不在此界面展示。

    // 7) 左下角齿轮：模型设置（接口地址 / API Key）
    ensureSettingsButton();
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
