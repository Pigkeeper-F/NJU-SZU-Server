/*!
 * 流程智能体 —— 顶部模块选项卡 window.ModuleTabs
 * 纯浏览器 script（零依赖 / 无 module / 无 fetch / 无 CDN），file:// 双击 index.html 即可运行。
 *
 * ============================ 职责边界 ============================
 * 只负责：① #module-tabs 容器内容（模块卡列表）② #module-chain 依赖链概览
 *         ③ #btn-add-module 的 click（静态节点，仅绑事件，绝不重建）
 * 不负责：#sidebar*（T2）、#module-space / #composer*（T4）；加载期不调用他人 render、
 *         不读写他人容器；不自行 Store.subscribe（由 app.js 统一调度，见 contract.md §7）。
 *
 * ============================ 契约要点 ============================
 * render() 幂等、可高频调用（拖拽侧栏时每帧）：
 *   - 每次自读 Store.getState()（深拷贝），不缓存旧 state；
 *   - 重建 #module-tabs 内部（.module-tab / .module-tab-active / .module-tab-title /
 *     .module-dep / .module-tab-del），文案一律 textContent（无 HTML 拼接，无注入面）；
 *   - 无模块 → 一个 .empty-state-hint「点击 ＋ 添加第一个模块」；
 *   - #module-chain 文案「模块1 → 模块2 → 模块3」，无模块时置空（CSS :empty 自动隐藏）。
 *
 * 事件（加载期各绑一次，全部委托在 #module-tabs 上，卡片数量变化无需重绑）：
 *   click   .module-tab            → Store.selectModule(id)
 *   click   .module-tab-del        → e.stopPropagation() + Store.removeModule(id)；
 *                                    {ok:false} 时把 reason 提示出来（system 气泡优先，退化 alert）
 *   pointerdown(capture) 锁定的 .module-tab-del[disabled] → 同上提示（见下方「删除保护」）
 *   dblclick .module-tab-title     → prompt 重命名 → Store.renameModule(id, 输入)（取消/空值忽略）
 *
 * 依赖规则：三条准备路径汇合到计算；通过 Store.getUpstreamModules 查询真实上游，
 * 存在下游 ⇒ 该卡删除键加 disabled + title 说明；
 * Store.removeModule() 同样会拒绝（双保险，判定权始终在数据层）。
 *
 * 删除保护为什么要用 pointerdown（实测结论，Chrome 137 headless + Input.dispatchMouseEvent 真实点击）：
 *   浏览器对被禁用的表单控件只派发 pointerdown，**完全不派发 mousedown / click**
 *   （实测事件序列仅 ["pointerdown|target=module-tab-del|disabled=true"]）。
 *   若只监听 click，用户点被锁定的 × 将毫无反馈。故在 #module-tabs 上用**捕获阶段**的
 *   pointerdown 兜住这一路径：仅当目标删除键带 disabled 时提示 reason；捕获阶段不依赖冒泡，
 *   且 disabled 控件不会再产生 click，故不会与 click 分支重复提示（另留 600ms 去抖兜底）。
 */
;(function (root, doc) {
  'use strict';

  var FIXED_MODULES = [
    { id: 'download-data', name: '下载数据' },
    { id: 'clean-data', name: '数据清洗' },
    { id: 'literature-mining', name: '文献挖掘' },
    { id: 'calculation', name: '模型调整与计算' },
    { id: 'parameter-update', name: '参数更新', conditional: true },
    { id: 'activity-data-update', name: '活动数据更新', conditional: true },
    { id: 'plotting', name: '绘图' },
    { id: 'result-audit', name: '结果核查与定位' },
    { id: 'manual-review', name: '人工审核' }
  ];
  var PREPARATION_TYPES = ['download-data', 'clean-data', 'literature-mining'];
  var EMPTY_HINT_TEXT = '选择准备环节，或直接进入模型调整与计算';
  var DEP_FIRST_TEXT = '起点';          // 首模块（dependsOn === null）
  var DEP_ARROW = '← ';                 // 其余模块：← 上游模块名
  var DEP_UNKNOWN_TEXT = '未知上游';     // 仅容错：dependsOn 指向已不存在的模块
  var LOCKED_TITLE = '有下游模块依赖，不能删除';
  var DEL_TITLE = '删除模块';
  var DEL_GLYPH = '×';
  var RENAME_PROMPT = '重命名模块';
  var FALLBACK_REASON = '删除失败';
  var LOCKED_DEDUPE_MS = 600; // pointerdown 已提示过时，抑制紧随其后的 click 重复提示

  // 静态节点：加载期取一次即可（#module-tabs 内部会被重建，但容器本身是静态的）
  var tabsEl = doc.getElementById('module-tabs');
  var chainEl = doc.getElementById('module-chain');
  var addBtn = doc.getElementById('btn-add-module');
  var addMenuEl = doc.getElementById('fixed-module-menu');
  var nextModule = null;
  var pendingCalculationModule = null;

  var lastLockedTipAt = 0; // 最近一次「锁定删除键」提示时间戳（仅用于去抖重复提示）

  function getStore() {
    return (root && root.Store) ? root.Store : null;
  }

  /** 在 boundary 内自 node 起向上查找第一个匹配 selector 的元素（不越过 boundary） */
  function closestWithin(node, selector, boundary) {
    while (node && node !== boundary) {
      if (node.nodeType === 1 && typeof node.matches === 'function' && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function findModuleName(modules, id) {
    for (var i = 0; i < modules.length; i++) {
      if (modules[i].id === id) return modules[i].name;
    }
    return null;
  }

  /** 是否存在依赖该模块的下游模块（= 该卡不是链尾，不可删） */
  function hasDownstream(modules, id) {
    for (var i = 0; i < modules.length; i++) {
      if (getStore().getUpstreamModules(modules[i].id).some(function (item) { return item.id === id; })) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ 构建

  function createTab(mod, activeId, modules) {
    var tab = doc.createElement('div');
    tab.className = 'module-tab' + (mod.id === activeId ? ' module-tab-active' : '');
    tab.setAttribute('data-id', mod.id);
    tab.setAttribute('role', 'tab');
    if (mod.id === activeId) tab.setAttribute('aria-selected', 'true');

    // 模块名（全名放 title，便于省略号截断后仍可悬停查看）
    var title = doc.createElement('span');
    title.className = 'module-tab-title';
    title.textContent = mod.name;
    title.setAttribute('title', mod.name);
    tab.appendChild(title);

    if (mod.type === 'calculation') {
      var mode = doc.createElement('span');
      mode.className = 'module-dep';
      mode.textContent = ({ direct: '运行现有代码', modify: '修改代码后计算', 'parameter-update': '参数更新', 'activity-data-update': '活动数据更新' })[mod.mode] || '选择计算方式';
      tab.appendChild(mode);
    }
    // 状态徽标（流程模块的审核状态：待开始 / 进行中 / 待审核 / 已通过）
    var statusMeta = { todo: '○', doing: '◐', review: '⏳', approved: '✓' };
    var statusText = { todo: '待开始', doing: '进行中', review: '待审核', approved: '已通过' };
    var st = statusMeta[mod.status] ? mod.status : 'todo';
    var chip = doc.createElement('span');
    chip.className = 'module-status';
    chip.textContent = statusMeta[st];
    chip.setAttribute('data-status', st);
    chip.setAttribute('title', '状态：' + statusText[st]);
    tab.appendChild(chip);

    // 依赖徽标：首模块「起点」，其余「← 上游模块名」
    var dep = doc.createElement('span');
    dep.className = 'module-dep';
    var upstream = getStore().getUpstreamModules(mod.id);
    if (PREPARATION_TYPES.indexOf(mod.type) >= 0) {
      dep.textContent = '并列准备 · 成果供计算使用';
      dep.setAttribute('title', '可独立开展；成果按需用于模型调整与计算');
    } else if (mod.type === 'calculation') {
      dep.textContent = '← 三条准备路径按需汇入';
      dep.setAttribute('title', '下载数据、数据清洗、文献挖掘；不要求全部完成');
    } else if (!upstream.length) {
      dep.textContent = DEP_FIRST_TEXT;
      dep.setAttribute('title', '依赖链起点（无上游模块）');
    } else {
      var upName = upstream.map(function (item) { return item.name; }).join(' / ');
      dep.textContent = DEP_ARROW + (upName || DEP_UNKNOWN_TEXT);
      dep.setAttribute('title', upName ? ('依赖上游模块：' + upName) : '上游模块已不存在');
    }
    tab.appendChild(dep);

    // 删除键：有下游依赖 → disabled + 说明（CSS .module-tab-del[disabled] 已备样式）
    var del = doc.createElement('button');
    del.type = 'button';
    del.className = 'module-tab-del';
    del.textContent = DEL_GLYPH;
    del.setAttribute('data-act', 'del');
    if (hasDownstream(modules, mod.id) || (mod.type === 'calculation' && !mod.mode)) {
      del.disabled = true;
      del.setAttribute('aria-disabled', 'true');
      del.setAttribute('title', hasDownstream(modules, mod.id) ? LOCKED_TITLE : '先选择计算方式');
    } else {
      del.setAttribute('title', DEL_TITLE);
    }
    tab.appendChild(del);

    return tab;
  }

  // ------------------------------------------------------------ 渲染

  function render() {
    if (!tabsEl) return;
    var S = getStore();
    if (!S) return; // 数据层缺失：静默（T5/app.js 负责给出明确报错）

    var state = S.getState() || {};
    var modules = state.modules || [];
    var activeId = state.activeModuleId;
    var moduleTypes = modules.map(function (item) { return item.type; });
    var calculation = modules.filter(function (item) { return item.type === 'calculation'; })[0];
    var workflowLocked = false;

    tabsEl.innerHTML = '';

    if (!modules.length) {
      var hint = doc.createElement('div');
      hint.className = 'empty-state-hint';
      hint.textContent = EMPTY_HINT_TEXT;
      tabsEl.appendChild(hint);
      if (chainEl) {
        chainEl.textContent = '';
        chainEl.removeAttribute('title');
      }
    }

    var calc = modules.filter(function (item) { return item.type === 'calculation'; })[0];
    var chooser = null;
    if (calc && calc.id === activeId && !calc.mode) {
      var chooser = doc.createElement('div');
      chooser.className = 'calculation-mode-chooser';
      var title = doc.createElement('span');
      title.textContent = '选择计算方式：';
      chooser.appendChild(title);
      var choices = [
        ['direct', '直接计算 · 上传代码与输入数据'],
        ['modify', '修改计算 · 讨论并确认修改规则']
      ];
      if (calc.mode) {
        chooser.appendChild((function () {
          var text = doc.createElement('span');
          text.textContent = '当前方式：' + ({direct:'直接计算', modify:'修改计算', 'parameter-update':'参数更新', 'activity-data-update':'活动数据更新'})[calc.mode];
          return text;
        })());
        choices = [];
      }
      choices.forEach(function (choice) {
        var button = doc.createElement('button');
        button.type = 'button';
        button.className = 'calculation-mode-option';
        button.setAttribute('data-mode', choice[0]);
        button.textContent = choice[1];
        chooser.appendChild(button);
      });
    }

    if (addMenuEl) {
      nextModule = null;
      pendingCalculationModule = null;
      for (var fi = 0; fi < FIXED_MODULES.length; fi++) {
        if (!FIXED_MODULES[fi].conditional && moduleTypes.indexOf(FIXED_MODULES[fi].id) < 0) { nextModule = FIXED_MODULES[fi]; break; }
      }
      if (calculation && ['parameter-update', 'activity-data-update'].indexOf(calculation.mode) >= 0 && moduleTypes.indexOf(calculation.mode) < 0) {
        pendingCalculationModule = calculation.mode === 'parameter-update'
          ? { id: 'parameter-update', name: '参数更新' }
          : { id: 'activity-data-update', name: '活动数据更新' };
      }
      addMenuEl.textContent = pendingCalculationModule ? '可添加：' + pendingCalculationModule.name : nextModule ? '可添加：' + nextModule.name : '所有环节已添加';
      addMenuEl.hidden = !nextModule && !pendingCalculationModule;
    }
    if (addBtn) {
      workflowLocked = !!nextModule && ['plotting', 'result-audit', 'manual-review'].indexOf(nextModule.id) >= 0 && (!calculation || !calculation.mode);
      var calculationSubmoduleNeeded = calculation && ['parameter-update', 'activity-data-update'].indexOf(calculation.mode) >= 0 && !modules.some(function (item) { return item.type === calculation.mode; });
      addBtn.disabled = workflowLocked || (!nextModule && !calculationSubmoduleNeeded);
      if (workflowLocked) addBtn.title = '先选择计算方式';
      else if (calculationSubmoduleNeeded) addBtn.title = '添加：' + (calculation.mode === 'parameter-update' ? '参数更新' : '活动数据更新');
      else if (!nextModule) addBtn.title = '固定流程已全部添加';
      else addBtn.title = '添加环节：' + nextModule.name;
    }

    var activeEl = null;
    var names = [];
    var prepHeading = doc.createElement('div');
    prepHeading.className = 'workflow-group-title';
    prepHeading.textContent = '准备资料 · 三条并列路径';
    tabsEl.appendChild(prepHeading);
    var preparationsDone = false;
    function finishPreparations() {
      if (preparationsDone) return;
      preparationsDone = true;
      var options = doc.createElement('div'); options.className = 'workflow-preparation-actions';
      FIXED_MODULES.filter(function (item) { return PREPARATION_TYPES.indexOf(item.id) >= 0 && moduleTypes.indexOf(item.id) < 0; }).forEach(function (item) {
        var button = doc.createElement('button'); button.type = 'button'; button.className = 'quiet-button';
        button.textContent = '+ ' + item.name; button.setAttribute('data-add-type', item.id); options.appendChild(button);
      });
      if (options.children.length) tabsEl.appendChild(options);
      var heading = doc.createElement('div'); heading.className = 'workflow-group-title'; heading.textContent = '汇入模型 · 计算与结果'; tabsEl.appendChild(heading);
      if (!calculation) {
        var enter = doc.createElement('button'); enter.type = 'button'; enter.className = 'quiet-button';
        enter.textContent = '进入模型调整与计算'; enter.setAttribute('data-add-type', 'calculation'); tabsEl.appendChild(enter);
      }
    }
    for (var i = 0; i < modules.length; i++) {
      if (PREPARATION_TYPES.indexOf(modules[i].type) < 0) finishPreparations();
      var el = createTab(modules[i], activeId, modules);
      tabsEl.appendChild(el);
      names.push(modules[i].name);
      if (modules[i].id === activeId) activeEl = el;
    }
    finishPreparations();
    if (chooser) tabsEl.appendChild(chooser);

    // 依赖链概览：模块1 → 模块2 → 模块3（无模块时上面已置空，CSS :empty 自动隐藏）
    if (chainEl) {
      chainEl.textContent = '（下载数据 / 数据清洗 / 文献挖掘）→ 模型调整与计算 → 绘图 → 结果核查与定位 → 人工审核';
      chainEl.setAttribute('title', chainEl.textContent);
    }

    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  // ------------------------------------------------------------ 事件

  /** 统一提示：优先写进当前模块的 system 气泡（T4 渲染），无当前模块时退化 alert */
  function showReason(reason) {
    var S = getStore();
    var text = reason || FALLBACK_REASON;
    if (!S) {
      if (root.alert) root.alert(text);
      return;
    }
    var state = S.getState() || {};
    var activeId = state.activeModuleId;
    if (activeId && S.appendMessage(activeId, text, 'system')) return;
    if (root.alert) root.alert(text);
  }

  function removeWithFeedback(id) {
    var S = getStore();
    if (!S) return;
    var res = S.removeModule(id);
    if (res && res.ok === false) showReason(res.reason);
  }

  /**
   * 捕获阶段的 pointerdown：兜住「被锁定（disabled）的删除键」这一路径。
   * 实测：真实点击 disabled 控件时浏览器只派发 pointerdown，不派发 click ⇒ 只能在这里给反馈。
   */
  function onTabsPointerDown(e) {
    if (!tabsEl) return;
    if (typeof e.button === 'number' && e.button !== 0) return; // 只管主键（左键 / 触摸）
    var del = closestWithin(e.target, '.module-tab-del', tabsEl);
    if (!del || !del.disabled) return;                          // 可用的删除键交给 click 分支

    var tab = closestWithin(del, '.module-tab', tabsEl);
    var id = tab && tab.getAttribute('data-id');
    if (!id) return;

    lastLockedTipAt = Date.now();
    removeWithFeedback(id); // 判定权仍在 Store：{ok:false, reason} → 提示
  }

  function onTabsClick(e) {
    if (!tabsEl) return;
    var S = getStore();
    var addPath = closestWithin(e.target, '[data-add-type]', tabsEl);
    if (addPath) {
      var definition = FIXED_MODULES.filter(function (item) { return item.id === addPath.getAttribute('data-add-type'); })[0];
      if (definition) S.addModule(definition.name);
      return;
    }
    if (!S) return;

    var modeButton = closestWithin(e.target, '.calculation-mode-option', tabsEl);
    if (modeButton) {
      var calculation = S.getState().modules.filter(function (item) { return item.type === 'calculation'; })[0];
      if (calculation) S.setModuleMode(calculation.id, modeButton.getAttribute('data-mode'));
      return;
    }

    var tab = closestWithin(e.target, '.module-tab', tabsEl);
    if (!tab) return; // 点在空状态提示或空白处
    var id = tab.getAttribute('data-id');
    if (!id) return;

    var del = closestWithin(e.target, '.module-tab-del', tabsEl);
    if (del) {
      // 删除键：阻止冒泡，避免同时触发卡片选中。
      // 带 disabled 的删除键通常根本收不到 click（已由 pointerdown 分支提示过）——若能收到，
      // 说明浏览器派发了 click，此时按 600ms 去抖避免同一操作提示两遍；过期则照常提示。
      e.stopPropagation();
      if (del.disabled && (Date.now() - lastLockedTipAt) < LOCKED_DEDUPE_MS) return;
      removeWithFeedback(id);
      return;
    }

    S.selectModule(id);
  }

  function onTabsDblClick(e) {
    if (!tabsEl) return;
    var S = getStore();
    if (!S) return;

    var title = closestWithin(e.target, '.module-tab-title', tabsEl);
    if (!title) return;
    var tab = closestWithin(title, '.module-tab', tabsEl);
    if (!tab) return;
    var id = tab.getAttribute('data-id');
    if (!id) return;

    // 【安全修复 · 2026-10-13】优先走统一的命名 dialog（workspace.js 暴露），
    // 交互风格与「新建模块 / 项目改名」一致；WorkspaceUI 未就绪时退回原生 prompt。
    var ui = root.WorkspaceUI;
    if (ui && typeof ui.openRenameDialog === 'function') {
      ui.openRenameDialog(id, title.textContent || '');
      return;
    }

    var next = root.prompt ? root.prompt(RENAME_PROMPT, title.textContent || '') : null;
    if (next === null || typeof next === 'undefined') return; // 取消
    if (!String(next).trim()) return;                        // 空值忽略
    S.renameModule(id, next);
  }

  function onAddClick() {
    var S = getStore();
    if (!S) return;
    if (pendingCalculationModule) {
      S.addModule(pendingCalculationModule.name);
      return;
    }
    if (!nextModule) return;
    S.addModule(nextModule.name);
  }

  // 加载期只绑一次（委托：卡片重建无需重绑；#btn-add-module 是静态节点，只绑事件不重建）
  if (tabsEl) {
    tabsEl.addEventListener('pointerdown', onTabsPointerDown, true); // 捕获：兜住 disabled 删除键
    tabsEl.addEventListener('click', onTabsClick);
    tabsEl.addEventListener('dblclick', onTabsDblClick);
  }
  if (addBtn) addBtn.addEventListener('click', onAddClick);

  root.ModuleTabs = { render: render };
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
