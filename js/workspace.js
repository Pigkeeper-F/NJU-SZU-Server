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
    const panel = node('details', 'literature-workflow');
    panel.append(node('summary', '', '工作流说明 · 文献 meta 与参数挖掘'));
    panel.setAttribute('aria-labelledby', 'literature-workflow-title');
    const head = node('div', 'literature-workflow-head');
    head.append(node('div', 'eyebrow', 'WORKFLOW'), node('h2', '', '从研究主题到文献 meta 与参数'), node('p', '', '通用工作流定义。每个主题单独配置检索范围、纳入规则和字段；SOC 只是一个实例，不是全局规则。'));
    panel.append(head);
    const stages = [
      ['定义', '输入一个研究主题，形成可追溯、可复核的结构化文献及研究参数数据。'],
      ['输入', '必填：主题。可选：研究目的、地域/时间范围、目标数量、纳入/排除标准、字段模板、已有文献或数据。缺省项先提出建议，确认后执行。'],
      ['执行', '扩展检索词并检索来源；合并去重；按规则标注纳入/排除/待复核；获取全文（HTML 优先、PDF 备选）；提取文献 meta 与主题参数；统一单位和分类，同时保留原始值及证据。'],
      ['交付', '结构化 CSV/XLSX（可附逐篇 JSON）、检索与筛选日志、规则版本、纳入/排除数量、来源证据，以及待人工复核清单。'],
      ['检查', '检查必填字段、重复记录、单位与范围、来源可追溯性、提取值是否有原文证据；抽样复核准确性并报告检索覆盖与缺失。'],
      ['异常', '全文不可得、字段缺失/冲突、图表无法可靠读取、候选不足或规则有歧义时，明确标记原因并转人工审核；不得猜测或补造数据。']
    ];
    const grid = node('div', 'literature-workflow-grid');
    stages.forEach(([title, description], index) => {
      const item = node('article', 'literature-workflow-stage');
      item.append(node('span', 'literature-workflow-number', String(index + 1).padStart(2, '0')), node('h3', '', title), node('p', '', description));
      grid.append(item);
    });
    panel.append(grid);
    const example = node('details', 'literature-workflow-example');
    const summary = node('summary', '', 'SOC 示例配置（仅作为主题实例）');
    const exampleText = node('p', '', '主题可限定为中国地区、可定位样点的原始田间研究和明确报告的土壤有机碳（SOC）数据；按地点、年份、处理、作物与施肥等字段提取并保留原文证据。综述、无法定位或不符合地域范围的记录按该实例规则排除或复核。切换主题时，应替换这些筛选条件与字段，不沿用 SOC 专属规则。');
    example.append(summary, exampleText);
    panel.append(example);
    return panel;
  }
  function decorateSpace() {
    const state = Store.getState();
    const notes = $('conversation-mode').value === 'notes';
    const moduleSpace = $('module-space');
    const existingWorkflow = moduleSpace.querySelector('.literature-workflow');
    if (existingWorkflow) existingWorkflow.remove();
    const activeModule = state.modules.find(mod => mod.id === state.activeModuleId);
    if (activeModule && activeModule.type === 'literature-mining') {
      const workflow = literatureWorkflow();
      const messages = moduleSpace.querySelector('.msg-list');
      if (messages) moduleSpace.insertBefore(workflow, messages);
      else moduleSpace.append(workflow);
    }
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
    root.replaceChildren();
    const groups = state.modules.filter(mod => mod.messages.length);
    if (!groups.length) {
      const empty = node('div', 'records-empty');
      empty.append(node('h2', '', '记录会在这里汇集'), node('p', '', '在任意模块中留下第一条记录，就可以在这里回顾。'));
      root.append(empty);
      return;
    }
    root.append(node('p', 'records-intro', '按模块回顾研究中的想法与讨论。'));
    groups.forEach(mod => {
      const group = node('section', 'record-group');
      group.append(node('h2', '', mod.name));
      mod.messages.forEach(message => {
        const card = node('article', 'record-item');
        card.append(node('small', '', ({ user: '我的记录', assistant: 'AI 回复', system: '系统提示' }[message.role]) + ' · ' + formatDate(message.at)), node('p', '', message.text));
        group.append(card);
      });
      const link = node('button', 'record-link', '返回此模块 ↗');
      link.type = 'button';
      link.addEventListener('click', () => { Store.selectModule(mod.id); switchView('workspace'); });
      group.append(link);
      root.append(group);
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
  if (matchMedia('(max-width: 640px)').matches) Store.setSidebar({ collapsed: true });
  Store.subscribe(render);
  render();
})();
