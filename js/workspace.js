/* Presentation layer. Existing module state and the optional AI connection stay intact. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let currentView = 'workspace';
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className || '';
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function formatDate(value) {
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  }
  function switchView(view) {
    currentView = view;
    render();
  }
  function welcome() {
    const panel = node('div', 'welcome');
    panel.append(node('div', 'eyebrow', '研序 · 研究工作台'), node('h2', '', '开始你的研究'), node('p', '', '从下载数据开始，逐步完成清洗、计算与分析。每个模块都有独立的对话与工作记录。'));
    const button = node('button', 'primary-button', '＋ 创建第一个模块');
    button.type = 'button';
    button.addEventListener('click', () => Store.addModule('下载数据'));
    panel.append(button);
    return panel;
  }
  function literatureWorkflow() {
    const panel = node('section', 'literature-workflow');
    panel.setAttribute('aria-label', '文献挖掘使用说明');
    const head = node('div', 'literature-workflow-head');
    head.append(node('h2', '', '讨论需求 → 确认设置 → 执行 → 核查结果'), node('p', '', '这里是操作说明，不是本次研究的执行方案。每个主题分别确定检索范围、纳入规则和提取字段。'));
    panel.append(head);
    const stages = [
      ['先讨论需求', '在底部 AI 对话中说明要找的研究和数据，讨论范围、纳排条件及字段。讨论本身不会开始检索。'],
      ['核对本次检索设置', '点“从对话整理规则”，再展开“本次检索设置”检查主题、检索词、来源、年份和目标字段。可以直接修改，AI 建议需你核对。'],
      ['选择本次做到哪一步', '可先只检索候选文献，或继续到全文获取、提取、校验和导出。确认后点击“确认配置并检索”才开始。'],
      ['确认字段后提取', '进入提取前，确认每个字段的含义与单位。模型按确认内容逐篇提取，并保存原文出处和缺失情况。'],
      ['核查结果与历史任务', '检查提取值和出处，下载 CSV/Excel。历史任务用于查看已运行批次，也可继续尚未完成的阶段。'],
      ['遇到问题', '六阶段检索支持 Google Scholar、中国知网与 Web of Science 核心合集，各来源可单独填写检索式。遇到登录、验证码或机构权限要求时，点“打开登录/检索页面”在官方网页操作，再点“检查并继续”恢复原任务。登录成功不代表已有数据库或全文访问权限；无法取得全文或数据时如实标记。Meta 作者的分析输入附件需要另行核查，不能默认已经拿齐。']
    ];
    const grid = node('div', 'literature-workflow-grid');
    stages.forEach(([title, description], index) => {
      const item = node('article', 'literature-workflow-stage');
      item.append(node('span', 'literature-workflow-number', String(index + 1).padStart(2, '0')), node('h3', '', title), node('p', '', description));
      grid.append(item);
    });
    panel.append(grid);
    panel.append(node('p', '', '首次运行可能需要准备 Python 依赖和 Chromium 浏览器组件。提取前的字段确认、执行中的提示与结果核查，仍需要研究者参与。'));
    const example = node('details', 'literature-workflow-example');
    const summary = node('summary', '', 'SOC 示例配置（仅作为主题实例）');
    const exampleText = node('p', '', '主题可限定为中国地区、可定位样点的原始田间研究和明确报告的土壤有机碳（SOC）数据；按地点、年份、处理、作物与施肥等字段提取并保留原文证据。综述、无法定位或不符合地域范围的记录按该实例规则排除或复核。切换主题时，应替换这些筛选条件与字段，不沿用 SOC 专属规则。');
    example.append(summary, exampleText);
    panel.append(example);
    return panel;
  }
  let literatureHelpDialog = null;
  document.addEventListener('literature-help-open', () => {
    if (!literatureHelpDialog) {
      literatureHelpDialog = node('dialog', 'literature-help-dialog');
      literatureHelpDialog.setAttribute('aria-label', '文献挖掘使用说明');
      const head = node('div', 'literature-help-head');
      const close = node('button', 'quiet-button', '关闭'); close.type = 'button';
      close.addEventListener('click', () => literatureHelpDialog.close());
      head.append(node('h2', '', '文献挖掘 · 使用说明'), close);
      literatureHelpDialog.append(head, literatureWorkflow());
      document.body.append(literatureHelpDialog);
    }
    if (!literatureHelpDialog.open) literatureHelpDialog.showModal();
  });
  function decorateSpace() {
    const state = Store.getState();
    const notes = $('conversation-mode').value === 'notes';
    const moduleSpace = $('module-space');
    const existingWorkflow = moduleSpace.querySelector('.literature-workflow');
    if (existingWorkflow) existingWorkflow.remove();
    const activeModule = state.modules.find(mod => mod.id === state.activeModuleId);
    if (!state.modules.length) $('module-space').replaceChildren(welcome());
    if (notes && state.activeModuleId) {
      $('composer-input').disabled = false;
      $('composer-input').placeholder = '写下你的想法、问题，或这一步的工作记录…';
      $('btn-send').disabled = false;
    }
    $('btn-send').textContent = notes ? '记录 ↑' : '发送 ↑';
    const codex = activeModule && window.CodexUI && window.CodexUI.useCodex(activeModule);
    $('mode-description').textContent = notes ? '仅保存，不发送给 AI' : codex ? '本机 Codex · 无需 API Key' : '使用已配置的 API';
    document.querySelector('.composer-hint').textContent = 'Enter ' + (notes ? '保存' : '发送') + ' · Shift + Enter 换行';
    if (window.CodexUI) window.CodexUI.render();
  }
  const originalRender = ModuleSpace.render;
  ModuleSpace.render = function () { originalRender(); decorateSpace(); };
  function renderRecords(state) {
    const root = $('records-list');
    const searchEl = $('records-search');
    const query = (searchEl ? searchEl.value : '').trim().toLowerCase();
    root.replaceChildren();
    // 【体验升级 · 2026-10-13】支持按内容搜索过滤（大小写不敏感；空查询显示全部）
    const groups = state.modules
      .map(mod => ({
        mod: mod,
        messages: query
          ? mod.messages.filter(m => String(m.text || '').toLowerCase().includes(query))
          : mod.messages
      }))
      .filter(group => group.messages.length);
    if (!groups.length) {
      const empty = node('div', 'records-empty');
      if (query) {
        empty.append(node('h2', '', '没有匹配的记录'), node('p', '', '换个关键词试试，或清空搜索框查看全部记录。'));
      } else {
        empty.append(node('h2', '', '记录会在这里汇集'), node('p', '', '在任意模块中留下第一条记录，就可以在这里回顾。'));
      }
      root.append(empty);
      return;
    }
    root.append(node('p', 'records-intro', query
      ? '匹配 ' + groups.reduce((n, g) => n + g.messages.length, 0) + ' 条记录：'
      : '按模块回顾研究中的想法与讨论。'));
    groups.forEach(group => {
      const mod = group.mod;
      const section = node('section', 'record-group');
      section.append(node('h2', '', mod.name));
      group.messages.forEach(message => {
        const card = node('article', 'record-item');
        card.append(node('small', '', ({ user: '我的记录', assistant: 'AI 回复', system: '系统提示' }[message.role]) + ' · ' + formatDate(message.at)), node('p', '', message.text));
        section.append(card);
      });
      const link = node('button', 'record-link', '返回此模块 ↗');
      link.type = 'button';
      link.addEventListener('click', () => { Store.selectModule(mod.id); switchView('workspace'); });
      section.append(link);
      root.append(section);
    });
  }
  function render() {
    const state = Store.getState();
    const messages = state.modules.flatMap(mod => mod.messages.map(message => ({ ...message, moduleName: mod.name })));
    $('records-count').textContent = messages.length;
    const active = state.modules.find(mod => mod.id === state.activeModuleId);
    $('module-count').textContent = state.modules.length + ' 个模块';
    $('section-name').textContent = currentView === 'workspace' ? active?.name || '开始研究' : '工作记录';
    $('active-module-meta').textContent = currentView === 'workspace' ? active ? active.messages.length + ' 条消息' : '' : messages.length + ' 条记录';
    document.querySelectorAll('[data-view]').forEach(el => {
      el.classList.toggle('is-active', el.dataset.view === currentView);
      if (el.dataset.view === currentView) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    document.querySelector('.module-tabs-bar').hidden = currentView !== 'workspace';
    document.querySelector('.module-tabs-bar').classList.toggle('is-empty', !state.modules.length);
    $('module-space').hidden = currentView !== 'workspace';
    $('composer').hidden = currentView !== 'workspace';
    $('records-view').hidden = currentView !== 'records';
    document.querySelectorAll('.module-tab, .sidebar-tab').forEach(el => { el.tabIndex = 0; });
    if (currentView === 'records') renderRecords(state);
    decorateSpace();
  }
  document.querySelectorAll('[data-new-module]').forEach(button => button.addEventListener('click', () => {
    const modules = Store.getState().modules;
    let next = null;
    for (const item of [
      { type: 'download-data', name: '下载数据' },
      { type: 'clean-data', name: '数据清洗' },
      { type: 'calculation', name: '计算' },
      { type: 'parameter-update', name: '参数更新', conditional: true },
      { type: 'activity-data-update', name: '活动数据更新', conditional: true },
      { type: 'result-audit', name: '结果核查与定位' },
      { type: 'literature-mining', name: '文献挖掘' },
      { type: 'manual-review', name: '人工审核' },
      { type: 'plotting', name: '绘图' }
    ]) {
      if (!item.conditional && !modules.some(mod => mod.type === item.type)) { next = item; break; }
    }
    const calc = modules.find(mod => mod.type === 'calculation');
    const calculationSubmodule = calc && ['parameter-update', 'activity-data-update'].includes(calc.mode) && !modules.some(mod => mod.type === calc.mode)
      ? ({ 'parameter-update': '参数更新', 'activity-data-update': '活动数据更新' }[calc.mode])
      : null;
    if (calculationSubmodule || next) { Store.addModule(calculationSubmodule || next.name); currentView = 'workspace'; }
  }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('edit-dependencies-button').addEventListener('click', async () => {
    const button = $('edit-dependencies-button');
    button.disabled = true;
    try {
      const response = await fetch('/api/dependencies/open', { method: 'POST', headers: { 'X-Workbench': '1' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法打开依赖清单');
    } catch (error) {
      const toast = $('toast');
      toast.textContent = error.message;
      toast.hidden = false;
      setTimeout(() => { toast.hidden = true; }, 4000);
    } finally {
      button.disabled = false;
    }
  });
  $('conversation-mode').addEventListener('change', () => ModuleSpace.render());
  function saveNote(event) {
    if ($('conversation-mode').value !== 'notes') return;
    if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const state = Store.getState();
    const text = $('composer-input').value.trim();
    if (!state.activeModuleId || !text) return;
    const maxChars = (window.Store && window.Store.LIMITS && window.Store.LIMITS.MAX_MESSAGE_CHARS) || 20000;
    if (text.length > maxChars) { toast('单条记录最长 ' + maxChars + ' 字，请拆分后再保存。'); return; }
    Store.appendMessage(state.activeModuleId, text, 'user');
    $('composer-input').value = '';
    $('composer-input').style.height = 'auto';
    $('composer-input').focus();
  }
  $('btn-send').addEventListener('click', saveNote, true);
  $('composer-input').addEventListener('keydown', saveNote, true);
  $('module-tabs').addEventListener('keydown', event => {
    if (event.target.classList.contains('module-tab') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); Store.selectModule(event.target.dataset.id); }
  });
  $('module-tabs').addEventListener('click', event => {
    if (matchMedia('(max-width: 640px)').matches && event.target.closest('.module-tab') && !event.target.closest('button')) Store.setSidebar({ collapsed: true });
  });

  // ---------------- 数据备份 / 恢复（体验升级 · 2026-10-13） ----------------
  // 只备份研究记录；账号、API Key 和服务端 .workbench 文件均不包含。
  const BACKUP_KEYS = ['fa_state_v1', 'fa_projects_v1', 'research_workspace_meta_v1', 'fa_current_project_id_v1', 'research_tasks_v1', 'research_legacy_projects_imported_v1'];
  function backupKeys() {
    const keys = BACKUP_KEYS.slice();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('research_task_state_')) keys.push(key);
      }
    } catch (_) { /* 浏览器禁用持久存储时只导出可读的键 */ }
    return keys;
  }
  function dateStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  $('backup-project').addEventListener('click', () => {
    const data = {};
    backupKeys().forEach(k => {
      try { const v = localStorage.getItem(k); if (v !== null) data[k] = v; } catch (_) { /* 忽略 */ }
    });
    const payload = { app: 'yanxu-workspace', version: 1, exportedAt: new Date().toISOString(), data: data };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = node('a');
    link.href = url;
    link.download = '研序备份-' + dateStamp() + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('备份已导出（不含 API Key）');
  });
  $('import-project').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', event => {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let payload = null;
      try { payload = JSON.parse(String(reader.result)); } catch (_) { payload = null; }
      if (!payload || payload.app !== 'yanxu-workspace' || !payload.data || typeof payload.data !== 'object') {
        alert('备份文件无效：不是「研序」导出的备份，或文件已损坏。');
        return;
      }
      if (!confirm('导入将覆盖当前浏览器内的工作台数据（账号与登录状态不受影响）。继续吗？')) return;
      let ok = true;
      backupKeys().concat(Object.keys(payload.data).filter(k => k.startsWith('research_task_state_'))).forEach(k => {
        const v = payload.data[k];
        if (typeof v === 'string') {
          try { localStorage.setItem(k, v); } catch (_) { ok = false; }
        }
      });
      if (ok) { toast('导入成功，正在恢复…'); setTimeout(() => location.reload(), 600); }
      else alert('导入失败：浏览器本地存储不可用（隐私模式或空间已满）。');
    };
    reader.onerror = () => alert('读取文件失败，请重试。');
    reader.readAsText(file, 'utf-8');
  });
  // 搜索框：输入即过滤工作记录视图
  $('records-search').addEventListener('input', () => { if (currentView === 'records') render(); });
  if (matchMedia('(max-width: 640px)').matches) Store.setSidebar({ collapsed: true });
  Store.subscribe(render);
  render();
  // 【集成 · 2026-10-13】账号：侧栏显示当前用户 + 退出登录（守卫 js/guard.js 已保证已登录）
  const authUserEl = $('auth-user');
  if (authUserEl) authUserEl.textContent = window.AuthUser || '已登录';
  const logoutBtn = $('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    try { if (window.Session) window.Session.clear(); } catch (_) { /* 忽略 */ }
    location.replace('login.html');
  });
})();
