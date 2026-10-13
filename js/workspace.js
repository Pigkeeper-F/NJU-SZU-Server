/* Presentation layer. Existing module state and the optional AI connection stay intact. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const key = 'research_workspace_meta_v1';
  let meta = { name: '我的研究项目', note: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && typeof saved.name === 'string' && typeof saved.note === 'string') meta = saved;
  } catch (_) { /* Keep the in-memory workspace available. */ }
  let currentView = 'workspace';
  let dialogMode = 'module';
  let renameTargetId = null;
  let toastTimer;
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className || '';
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function saveMeta() {
    try { localStorage.setItem(key, JSON.stringify(meta)); return true; }
    catch (_) { return false; }
  }
  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }
  function formatDate(value) {
    return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function openDialog(mode, extra) {
    dialogMode = mode;
    const isProject = mode === 'project';
    const isRename = mode === 'rename';
    $('dialog-title').textContent = isRename ? '重命名模块' : isProject ? '修改项目名称' : '新建研究模块';
    $('dialog-eyebrow').textContent = isRename ? 'RENAME MODULE' : isProject ? 'PROJECT SETTINGS' : 'NEW MODULE';
    $('name-label').textContent = isRename ? '模块名称' : isProject ? '项目名称' : '模块名称';
    $('dialog-description').textContent = isRename
      ? '给模块换个名字，依赖链与已有记录都会保留。'
      : isProject ? '用一个清晰的名字，让研究更容易找到。' : '给这段工作起个名字，之后可以随时调整。';
    $('name-input').value = isProject ? meta.name : (isRename && extra ? (extra.name || '') : '');
    $('name-input').setCustomValidity('');
    $('name-input').placeholder = isRename ? '输入新的模块名称' : isProject ? '输入项目名称' : '例如：文献阅读、数据整理、研究讨论';
    $('name-dialog').showModal();
    $('name-input').focus();
  }
  function switchView(view) {
    currentView = view;
    render();
  }
  function welcome() {
    const panel = node('div', 'welcome');
    panel.append(node('div', 'welcome-symbol', '▤'), node('h2', '', '按业务流程开始'),
      node('p', '', '这个项目按「研究写作 + 投稿发表」两阶段共 9 步推进。一次建好 9 个模块，每个模块都带自己的名字与任务说明。'));
    const steps = (window.Store && window.Store.FLOW_STEPS) ? window.Store.FLOW_STEPS : [];
    const actions = node('div', 'welcome-actions');
    const firstName = steps.length ? steps[0].name : '第 1 步';
    const initButton = node('button', 'primary-button', '开始业务流程：' + firstName);
    initButton.type = 'button';
    initButton.addEventListener('click', () => {
      if (!window.Store) return;
      if (typeof window.Store.startFlow === 'function') window.Store.startFlow();
      else if (typeof window.Store.initFlowModules === 'function') window.Store.initFlowModules();
      render();
    });
    actions.append(initButton);
    const blankButton = node('button', 'quiet-button', '只建一个空白模块');
    blankButton.type = 'button';
    blankButton.addEventListener('click', () => openDialog('module'));
    actions.append(blankButton);
    panel.append(actions);
    if (steps.length) {
      panel.append(node('div', 'welcome-steps-title',
        '流程共 ' + steps.length + ' 步，通过一步的审核后，下一步才会出现：'));
      const list = node('ol', 'welcome-steps');
      steps.forEach(step => list.append(node('li', '', step.name)));
      panel.append(list);
    }
    const features = node('div', 'welcome-features');
    [['◫', '独立讨论空间'], ['▤', '记录自动保留'], ['↗', '随时导出']].forEach(([icon, label]) => {
      const item = node('span', '', label);
      item.prepend(node('b', '', icon));
      features.append(item);
    });
    panel.append(features);
    return panel;
  }
  function decorateSpace() {
    const state = Store.getState();
    const notes = $('conversation-mode').value === 'notes';
    if (!state.modules.length) $('module-space').replaceChildren(welcome());
    if (notes && state.activeModuleId) {
      $('composer-input').disabled = false;
      $('composer-input').placeholder = '写下你的想法、问题，或这一步的工作记录…';
      $('btn-send').disabled = false;
    }
    $('btn-send').textContent = notes ? '记录 ↑' : '发送 ↑';
    $('mode-description').textContent = notes ? '记录想法，随时继续' : '使用已配置的 AI 服务';
    document.querySelector('.composer-hint').textContent = notes ? 'Enter 保存记录 · Shift + Enter 换行 · 仅保存在当前浏览器' : 'Enter 发送 · Shift + Enter 换行 · 需要配置 AI 服务';
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
    ['project-title', 'detail-project-name', 'sidebar-project-name'].forEach(id => { $(id).textContent = meta.name; });
    $('stat-modules').textContent = state.modules.length;
    $('stat-messages').textContent = messages.length;
    $('records-count').textContent = messages.length;
    $('module-count').textContent = currentView === 'workspace' ? state.modules.length + ' 个模块' : messages.length + ' 条记录';
    $('section-name').textContent = currentView === 'workspace' ? '模块工作区' : '全部工作记录';
    $('view-breadcrumb').textContent = currentView === 'workspace' ? '研究空间' : '工作记录';
    document.querySelectorAll('[data-view]').forEach(el => {
      el.classList.toggle('is-active', el.dataset.view === currentView);
      if (el.dataset.view === currentView) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    document.querySelector('.module-tabs-bar').hidden = currentView !== 'workspace';
    document.querySelector('.module-tabs-bar').classList.toggle('is-empty', !state.modules.length);
    $('module-space').hidden = currentView !== 'workspace';
    $('composer').hidden = currentView !== 'workspace';
    $('records-view').hidden = currentView !== 'records';
    const activity = $('recent-activity');
    activity.replaceChildren();
    if (!messages.length) activity.append(node('p', 'activity-empty', '还没有新的记录。\n从一个想法开始，慢慢积累。'));
    messages.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).forEach(message => {
      const item = node('div', 'activity-item');
      item.append(node('p', '', message.text), node('small', '', message.moduleName + ' · ' + formatDate(message.at)));
      activity.append(item);
    });
    document.querySelectorAll('.module-tab, .sidebar-tab').forEach(el => { el.tabIndex = 0; });
    if (currentView === 'records') renderRecords(state);
    decorateSpace();
  }
  document.querySelectorAll('[data-new-module]').forEach(button => button.addEventListener('click', () => openDialog('module')));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('project-shortcut').addEventListener('click', () => switchView('workspace'));
  $('rename-project').addEventListener('click', () => openDialog('project'));
  ['close-dialog', 'cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('name-dialog').close()));
  $('name-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('name-input').value.trim();
    if (!name) { $('name-input').setCustomValidity('请输入名称'); $('name-input').reportValidity(); return; }
    if (dialogMode === 'project') { meta.name = name; toast(saveMeta() ? '项目名称已更新' : '名称已更新，当前浏览器无法持久保存'); }
    else if (dialogMode === 'rename') {
      if (!renameTargetId || !Store.renameModule(renameTargetId, name)) toast('重命名失败：模块不存在或名称无效');
      renameTargetId = null;
    }
    else { Store.addModule(name); currentView = 'workspace'; }
    $('name-dialog').close();
    render();
  });
  $('name-input').addEventListener('input', () => $('name-input').setCustomValidity(''));
  $('project-note').value = meta.note;
  $('project-note').addEventListener('input', () => { meta.note = $('project-note').value; $('note-status').textContent = saveMeta() ? '已保存' : '仅本次会话'; });
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
  $('toggle-details').addEventListener('click', () => {
    const narrow = matchMedia('(max-width: 980px)').matches;
    if (narrow) {
      document.querySelector('.workspace-body').classList.toggle('details-open');
      $('project-details').hidden = false;
      $('toggle-details').setAttribute('aria-expanded', document.querySelector('.workspace-body').classList.contains('details-open'));
    } else {
      $('project-details').hidden = !$('project-details').hidden;
      $('toggle-details').setAttribute('aria-expanded', !$('project-details').hidden);
    }
  });
  $('export-project').addEventListener('click', () => {
    const state = Store.getState();
    const lines = ['# ' + meta.name, '', '导出时间：' + new Date().toLocaleString('zh-CN'), '', '## 项目备忘', '', meta.note || '暂无备忘', ''];
    state.modules.forEach(mod => {
      lines.push('## ' + mod.name, '');
      mod.messages.forEach(message => { lines.push('### ' + ({ user: '我的记录', assistant: 'AI 回复', system: '系统提示' }[message.role]) + ' · ' + formatDate(message.at), '', message.text, ''); });
      if (!mod.messages.length) lines.push('暂无记录', '');
    });
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
    const link = node('a'); link.href = url; link.download = meta.name.replace(/[\\/:*?"<>|]/g, '_') + '.md'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('项目记录已导出');
  });
  if (matchMedia('(max-width: 640px)').matches) Store.setSidebar({ collapsed: true });
  if (matchMedia('(max-width: 980px)').matches) $('toggle-details').setAttribute('aria-expanded', 'false');
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
  // 【安全修复 · 2026-10-13】暴露重命名入口给 tabs.js（双击模块卡标题走统一命名 dialog，
  // 替代原生 prompt：风格一致、带长度校验与取消按钮）。
  window.WorkspaceUI = {
    openRenameDialog: function (id, currentName) {
      renameTargetId = (typeof id === 'string') ? id : null;
      openDialog('rename', { name: currentName || '' });
    }
  };
})();
