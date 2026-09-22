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
  function openDialog(mode) {
    dialogMode = mode;
    const rename = mode === 'project';
    $('dialog-title').textContent = rename ? '修改项目名称' : '新建研究模块';
    $('dialog-eyebrow').textContent = rename ? 'PROJECT SETTINGS' : 'NEW MODULE';
    $('name-label').textContent = rename ? '项目名称' : '模块名称';
    $('dialog-description').textContent = rename ? '用一个清晰的名字，让研究更容易找到。' : '给这段工作起个名字，之后可以随时调整。';
    $('name-input').value = rename ? meta.name : '';
    $('name-input').setCustomValidity('');
    $('name-input').placeholder = rename ? '输入项目名称' : '例如：文献阅读、数据整理、研究讨论';
    $('name-dialog').showModal();
    $('name-input').focus();
  }
  function switchView(view) {
    currentView = view;
    render();
  }
  function welcome() {
    const panel = node('div', 'welcome');
    panel.append(node('div', 'welcome-symbol', '▤'), node('h2', '', '从一个研究模块开始'), node('p', '', '为手头的研究留一个专注的空间。整理想法、展开讨论，也记录每一步进展。'));
    const button = node('button', 'primary-button', '＋ 创建第一个模块');
    button.type = 'button';
    button.addEventListener('click', () => openDialog('module'));
    panel.append(button);
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
})();
