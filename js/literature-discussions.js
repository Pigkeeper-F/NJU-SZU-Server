/* Complete local discussions and explicit, versioned localhost backups. */
(function (root) {
  'use strict';
  const pending = new Map(), states = new Map(), booted = new Set(), restoring = new Map(), scheduled = new Map();
  let viewer = null, activeModule = null, projectSwitching = false;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const element = (tag, text, cls) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (cls) item.className = cls; return item; };
  const button = (text, action) => { const item = element('button', text, 'quiet-button'); item.type = 'button'; item.onclick = action; return item; };
  function scope(moduleId) {
    const projectId = root.TaskManager?.currentTaskId?.(), mod = root.Store?.getState().modules.find(item => item.id === moduleId);
    if (!projectId || mod?.type !== 'literature-mining') return null;
    const manager = root.CodexUI?.literatureWorkspace?.(moduleId), workspace = manager?.active();
    return workspace ? { projectId, moduleId, mod, manager, workspace, key: projectId + ':' + moduleId + ':' + workspace.id } : null;
  }
  function setStatus(key, text, error = false) {
    states.set(key, { text, error });
    if (!projectSwitching) document.querySelectorAll?.('[data-literature-discussion-scope]').forEach(item => {
      if (item.getAttribute('data-literature-discussion-scope') === key) { item.textContent = text; item.className = error ? 'codex-error' : 'codex-status'; }
    });
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', ...(options.headers || {}) } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '讨论备份请求失败'); return data;
  }
  function archivePayload(envelope, name) {
    const value = envelope.snapshot, chat = value.chat || {}, rules = value.rules;
    return { projectId: envelope.projectId, moduleId: envelope.moduleId, workspaceId: envelope.workspaceId, name,
      snapshot: { messages: clone(value.module.messages || []), composer: chat.composer || '', docDraftText: chat.draftText || '', docEditing: chat.editing === true,
        config: clone(value.client?.literatureConfig || {}), until: value.client?.literatureUntil || 'discover', approvedDoc: clone(value.module.doc || null),
        rules: rules ? { draft: rules.draft || '', confirmed: rules.confirmed || '', versions: (rules.versions || []).map(version => ({ text: version.text || '', at: version.at })) } : null } };
  }
  function scanBrowser() {
    const records = [], errors = [], stored = root.LiteratureTaskWorkspaces?.discoverStored?.() || { records: [], errors: [] };
    errors.push(...stored.errors);
    stored.records.forEach(entry => records.push({ ...archivePayload(entry.envelope, entry.name), sourceKey: entry.sourceKey, sourceType: entry.sourceType,
      updatedAt: entry.updatedAt, moduleName: entry.envelope.snapshot.module.name || entry.moduleId }));
    const read = key => { const raw = root.localStorage.getItem(key); return raw == null ? null : JSON.parse(raw); };
    const taskNames = new Map();
    try { (read('research_tasks_v1')?.tasks || []).forEach(task => taskNames.set(task.id, task.name)); } catch (error) { errors.push('research_tasks_v1：' + error.message); }
    const addState = (state, sourceKey, projectId, projectName, details = {}) => {
      if (!state || !Array.isArray(state.modules)) return;
      state.modules.forEach(mod => {
        if (!Array.isArray(mod.messages) || !mod.messages.length) return;
        records.push({ projectId: projectId || 'legacy-browser', moduleId: mod.id || 'legacy-module', workspaceId: 'snapshot:' + sourceKey + ':' + mod.id,
          name: (projectName || taskNames.get(projectId) || projectId || '旧版项目') + ' · ' + (mod.name || '旧模块'), moduleName: mod.name || mod.id,
          sourceKey, sourceType: 'project-snapshot', ...details, snapshot: { messages: clone(mod.messages), composer: '', docDraftText: '', docEditing: false,
            config: {}, until: 'discover', approvedDoc: clone(mod.doc || null), rules: null } });
      });
    };
    const keys = new Set(['fa_state_v1', 'fa_projects_v1', 'research_task_bootstrap_backups_v1']);
    try { for (let i = 0; i < root.localStorage.length; i++) { const key = root.localStorage.key(i); if (key?.startsWith('research_task_state_')) keys.add(key); } }
    catch (error) { errors.push('浏览器键目录：' + error.message); }
    keys.forEach(key => {
      try {
        const value = read(key);
        if (key === 'research_task_bootstrap_backups_v1') {
          (value?.entries || []).forEach(entry => (entry.sources || []).forEach((source, index) => {
            if (source.raw == null) return;
            const label = key + ':' + entry.id + ':' + index + '（原键 ' + source.key + '）';
            try { addState(JSON.parse(source.raw), label, entry.projectId, '启动前保留的项目快照', { updatedAt: entry.savedAt, recoveryReason: entry.reason }); }
            catch (error) { errors.push(label + '：' + error.message); }
          }));
        }
        else if (key === 'fa_projects_v1') { if (Array.isArray(value)) value.forEach(project => addState(project, key + ':' + project.id, project.id, project.name)); }
        else addState(value, key, key.startsWith('research_task_state_') ? key.slice('research_task_state_'.length) : root.TaskManager?.currentTaskId?.(), key === 'fa_state_v1' ? '浏览器当前镜像' : null);
      } catch (error) { errors.push(key + '：' + error.message); }
    });
    return { records, errors };
  }
  async function send(entry) {
    if (entry.sending) return;
    entry.sending = true;
    const payload = entry.payload, signature = JSON.stringify(payload);
    try {
      await request('/api/literature/discussions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature });
      if (JSON.stringify(entry.payload) === signature) {
        pending.delete(entry.key); setStatus(entry.key, '讨论与草稿已保存到浏览器，并已备份到本机服务。');
      }
    } catch (error) { setStatus(entry.key, '浏览器讨论快照保留；本机备份失败：' + error.message + '。可点击“保存讨论与草稿”重试。', true); }
    finally { entry.sending = false; if (pending.get(entry.key) === entry && JSON.stringify(entry.payload) !== signature) entry.timer = setTimeout(() => send(entry), 500); }
  }
  function queue(payload, delay = 600) {
    const key = payload.projectId + ':' + payload.moduleId + ':' + payload.workspaceId;
    let entry = pending.get(key); if (!entry) { entry = { key, payload, timer: null, sending: false }; pending.set(key, entry); }
    entry.payload = payload; clearTimeout(entry.timer); entry.timer = setTimeout(() => send(entry), delay);
  }
  function save(moduleId, immediate = false) {
    if (projectSwitching) return { ok: true, skipped: true };
    const current = scope(moduleId); if (!current || current.manager.isChanging?.()) return { ok: true, skipped: true };
    if (restoring.has(current.key)) return { ok: true, skipped: true };
    const result = current.manager.saveActive();
    if (!result.ok) { setStatus(current.key, result.error + '，请保留页面并下载讨论备份。', true); return result; }
    try {
      queue(archivePayload(current.manager.captureCurrent(), current.workspace.name), immediate ? 0 : 600);
      setStatus(current.key, '讨论与草稿已保存到浏览器；正在备份到本机服务。'); return { ok: true };
    } catch (error) { setStatus(current.key, '讨论备份未完成：' + error.message, true); return { ok: false, error: error.message }; }
  }
  function schedule(moduleId) {
    if (projectSwitching) return;
    const current = scope(moduleId); if (!current || current.manager.isChanging?.()) return;
    clearTimeout(scheduled.get(current.key));
    scheduled.set(current.key, setTimeout(() => {
      scheduled.delete(current.key); const latest = scope(moduleId);
      if (latest?.key === current.key) save(moduleId);
    }, 350));
  }
  function restoreComposer(moduleId) {
    const current = scope(moduleId); if (!current || current.manager.isChanging?.()) return;
    try {
      const stored = current.manager.storedSnapshot(current.workspace.id);
      if (stored.snapshot.chat && root.ModuleSpace?.resetContext?.(moduleId, stored.snapshot.chat) === false) {
        if (!restoring.has(current.key)) {
          const timer = setTimeout(() => { restoring.delete(current.key); const latest = scope(moduleId); if (latest?.key === current.key) { restoreComposer(moduleId); if (!restoring.has(current.key)) save(moduleId); } }, 1500);
          restoring.set(current.key, timer); setStatus(current.key, '当前操作结束后恢复已保存输入；原讨论和输入快照保留。');
        }
        return false;
      }
      clearTimeout(restoring.get(current.key)); restoring.delete(current.key); root.ModuleSpace?.render?.(); return true;
    } catch (error) { setStatus(current.key, '未恢复输入草稿：' + error.message + '。已有讨论未改动。', true); }
  }
  function seedProject(moduleId) {
    const current = scope(moduleId); if (!current) return;
    const key = current.projectId + ':' + moduleId; if (booted.has(key)) return; booted.add(key);
    restoreComposer(moduleId);
    // Preserve a nonempty stored discussion before a stale empty Store is saved.
    // Its recovery source receives a distinct archive ID, so an empty active
    // payload cannot replace it in the debounce queue.
    save(moduleId);
    for (const entry of current.manager.list()) {
      const value = restoring.has(current.key) && entry.id === current.workspace.id ? current.manager.storedSnapshot(entry.id) : current.manager.snapshot(entry.id), chat = value.snapshot.chat;
      if (value.snapshot.module.messages?.length || chat?.composer || chat?.draftText) queue(archivePayload(value, entry.name));
    }
    const stored = root.LiteratureTaskWorkspaces?.discoverStored?.();
    (stored?.records || []).filter(entry => entry.projectId === current.projectId).forEach(entry => queue(archivePayload(entry.envelope, entry.name)));
  }
  function close() { const current = viewer; viewer = null; if (current) { current.dialog.close(); current.dialog.remove(); } }
  function currentView(state) { return viewer === state && root.TaskManager?.currentTaskId?.() === state.projectId && root.Store.getState().activeModuleId === state.moduleId; }
  function reveal(item) { item.scrollIntoView?.({ block: 'start' }); item.focus?.({ preventScroll: true }); }
  function showNotice(state, text, error = false) {
    state.notice.textContent = text; state.notice.className = error ? 'codex-error' : 'codex-status';
    state.notice.setAttribute('role', error ? 'alert' : 'status'); reveal(state.notice);
  }
  function requireView(state) {
    if (currentView(state)) return true;
    if (viewer === state) showNotice(state, '工作区已切换，请关闭此窗口，再从当前任务打开“讨论记录”。原讨论未改动。', true);
    return false;
  }
  function download(value, name, type) {
    const url = URL.createObjectURL(new Blob([value], { type })), link = element('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function preview(state, record, localId = null) {
    if (!requireView(state)) return;
    try {
    if (!record?.snapshot || !Array.isArray(record.snapshot.messages)) throw new Error('所选记录缺少讨论消息列表，原快照未改动。');
    const content = state.preview; content.replaceChildren();
    const data = record.snapshot;
    const heading = element('h3', '已打开：' + (record.name || '讨论全文')); heading.setAttribute('tabindex', '-1');
    content.append(heading, element('p', record.partial
      ? '旧核查保存的讨论片段，非完整主聊天。下方保留来源说明；不能把这些片段当作原讨论已经全部恢复。'
      : '此份记录保存了 ' + data.messages.length + ' 条讨论消息。查看不修改规则或启动任务。', 'codex-status'));
    if (record.sourceKey) content.append(element('p', '找到的来源：' + record.sourceKey + '；项目 ' + record.projectId + '；模块 ' + (record.moduleName || record.moduleId)
      + '。原记录保持原位，恢复会另建草稿，不自动合并不同任务。', 'codex-status'));
    const actions = element('div', undefined, 'literature-discussion-actions');
    actions.append(button('返回记录列表', () => reveal(state.listAnchor)), button(record.partial ? '下载片段JSON' : '下载完整JSON', () => download(JSON.stringify(record, null, 2), '讨论与草稿.json', 'application/json')),
      button('下载讨论全文', () => download((record.partial ? '【旧核查片段，非完整主聊天】\n\n' : '') + data.messages.map(message => '[' + message.role + '] ' + (message.at || '') + '\n' + message.text).join('\n\n')
        + '\n\n未发送输入：\n' + (data.composer || '') + '\n\n文档编辑草稿：\n' + (data.docDraftText || ''), '讨论全文.txt', 'text/plain;charset=utf-8')));
    const restore = button(localId ? '回到这份讨论' : record.partial ? '将这些片段恢复为新草稿' : '恢复为新的讨论草稿', () => {
      if (!requireView(state)) return;
      const current = scope(state.moduleId); if (!current) return;
      const result = localId ? current.manager.switch(localId) : current.manager.create({ name: (record.name || '讨论') .slice(0, 66) + ' · 恢复草稿',
        mode: data.config?.searchMode === 'formal' ? 'formal' : 'test', seedClient: { literatureConfig: data.config, literatureUntil: data.until }, discussion: data });
      if (!result.ok) { showNotice(state, result.error, true); return; }
      close(); root.CodexUI?.renderLiteratureWorkspace?.(state.moduleId); save(state.moduleId, true);
    });
    restore.disabled = root.ModuleSpace?.isBusy?.() || root.CodexUI?.busy?.(state.moduleId);
    actions.append(restore); content.append(actions);
    if (!localId) content.append(element('p', '这份记录会恢复到新文献工作区；消息与输入保留，方案和配置作为草稿，执行确认需重新核查。原讨论及旧版本仍保留。', 'codex-status'));
    data.messages.forEach(message => {
      const section = element('article', undefined, 'literature-discussion-message');
      section.append(element('strong', ({ user: '我', assistant: 'AI', system: '系统' }[message.role] || message.role) + ' · ' + (message.at || '')),
        element('pre', message.text)); content.append(section);
    });
    if (data.composer) content.append(element('h4', '未发送输入'), element('pre', data.composer));
    if (data.docDraftText) content.append(element('h4', '文档编辑草稿'), element('pre', data.docDraftText));
    content.hidden = false;
    state.notice.textContent = '已打开“' + (record.name || '讨论记录') + '” · ' + data.messages.length + ' 条消息 · 只读预览，尚未恢复。';
    state.notice.className = 'codex-status'; state.notice.setAttribute('role', 'status');
    reveal(heading);
    } catch (error) { showNotice(state, '讨论预览失败：' + error.message, true); }
  }
  async function loadArchive(state, meta) {
    if (!requireView(state)) return;
    const readSeq = (state.archiveReadSeq || 0) + 1; state.archiveReadSeq = readSeq;
    showNotice(state, '正在读取所选版本…');
    try {
      const params = new URLSearchParams({ projectId: meta.projectId || state.projectId, moduleId: meta.moduleId || state.moduleId, workspaceId: meta.workspaceId, revision: String(meta.revision) });
      const record = await request('/api/literature/discussion?' + params); if (state.archiveReadSeq !== readSeq || !requireView(state)) return;
      state.notice.textContent = ''; preview(state, record);
    } catch (error) { if (state.archiveReadSeq === readSeq && requireView(state)) showNotice(state, '存档读取失败：' + error.message, true); }
  }
  function recoveryRecord(source, state) {
    const current = scope(state.moduleId), messages = [], now = new Date().toISOString();
    const add = (role, text, id, at) => messages.push({ role, text, id, ...(at ? { at } : {}) });
    add('system', '这是从旧核查存档找回的讨论片段，不是完整主聊天。各片段保持分开并注明来源，可能有重叠；未保留的原消息时间在恢复后会显示恢复时间。为区分重叠片段，恢复后的消息使用新标识，原标识保留在可下载的来源JSON中。配置沿用当前草稿，恢复片段不表示新检索式已写入，也不继承任何确认。', source.id + ':recovery-note', now);
    (source.fragments || []).forEach((fragment, index) => {
      const origin = (fragment.sources || []).map(item => '核查 ' + item.reviewId + ' v' + item.revision + (item.recordedAt ? ' · ' + item.recordedAt : '') + (item.origin ? ' · ' + item.origin : '')).join('\n');
      add('system', '片段 ' + (index + 1) + ' · ' + (fragment.kind === 'main-context' ? '核查时保存的主讨论依据' : '逐项核查中的问答') + '\n' + origin, source.id + ':source:' + index, now);
      if (fragment.kind === 'main-context') (fragment.messages || []).forEach((message, offset) => add(message.role, message.text, source.id + ':' + index + ':' + offset, message.at));
      else {
        if (fragment.question) add('user', fragment.question, source.id + ':' + index + ':question', fragment.at);
        if (fragment.answer) add('assistant', fragment.answer, source.id + ':' + index + ':answer', fragment.at);
      }
    });
    const client = current?.manager.captureCurrent().snapshot.client;
    return { name: source.label || '旧核查讨论片段', partial: true, sourceRecovery: clone(source),
      snapshot: { messages, composer: '', docDraftText: '', docEditing: false, config: clone(client?.literatureConfig || {}), until: client?.literatureUntil || 'discover', approvedDoc: null, rules: null } };
  }
  async function loadRecoveries(state, container) {
    container.append(element('h3', '旧核查中的讨论片段（不完整）'), element('p', '正在检查旧核查是否还保存过讨论依据…', 'codex-status'));
    try {
      const result = await request('/api/literature/discussion-recovery'); if (!currentView(state)) return;
      container.replaceChildren(element('h3', '旧核查中的讨论片段（不完整）'));
      if (!result.recoveries?.length) container.append(element('p', '暂未找到旧核查保存的讨论片段。此项结果不代表原浏览器或其他网址的讨论已被删除。', 'codex-status'));
      (result.recoveries || []).forEach(meta => {
        const row = element('div', undefined, 'literature-discussion-row');
        row.append(element('span', meta.label + ' · ' + meta.messageCount + ' 条主讨论片段消息 · ' + meta.questionAnswerCount + ' 组核查问答 · ' + (meta.latestAt || '时间未记录')),
          button('查看核查讨论片段', async () => {
            if (!requireView(state)) return;
            const readSeq = (state.archiveReadSeq || 0) + 1; state.archiveReadSeq = readSeq; showNotice(state, '正在读取旧核查片段…');
            try {
              const source = await request('/api/literature/discussion-recovery?id=' + encodeURIComponent(meta.id));
              if (state.archiveReadSeq !== readSeq || !requireView(state)) return;
              state.notice.textContent = ''; preview(state, recoveryRecord(source, state));
            } catch (error) { if (state.archiveReadSeq === readSeq && requireView(state)) showNotice(state, '旧片段读取失败：' + error.message, true); }
          })); container.append(row);
      });
    } catch (error) { if (currentView(state)) container.append(element('p', '旧核查片段暂时无法检查：' + error.message + '。上方浏览器快照和本机版本仍保留。', 'codex-error')); }
  }
  async function open(moduleId) {
    const current = scope(moduleId); if (!current) return; save(moduleId); close();
    const dialog = element('dialog', undefined, 'literature-help-dialog literature-discussions-dialog'); dialog.setAttribute('aria-label', '讨论记录与草稿');
    const head = element('div', undefined, 'literature-help-head'); head.append(element('h2', '讨论记录与草稿'), button('关闭', close));
    const notice = element('p', '', 'codex-status'), list = element('div'), recovered = element('div'), remote = element('div'), recovery = element('div'), full = element('div');
    notice.setAttribute('tabindex', '-1'); notice.setAttribute('aria-live', 'polite'); full.hidden = true;
    dialog.append(head, element('p', '先查看当前任务，再检查这个浏览器同一网址保存的其他任务和旧版快照。这里不会把空任务当成全部讨论，也不会自动合并不同任务。', 'codex-status'), notice, full, list, recovered, remote, recovery);
    const listAnchor = element('h3', '当前文献任务的讨论'); listAnchor.setAttribute('tabindex', '-1');
    const state = { dialog, notice, preview: full, listAnchor, projectId: current.projectId, moduleId }; viewer = state;
    dialog.onclose = () => { if (viewer === state) viewer = null; dialog.remove(); }; document.body.append(dialog); dialog.showModal();
    list.append(listAnchor);
    current.manager.list().forEach(entry => {
      const row = element('div', undefined, 'literature-discussion-row');
      row.append(element('span', entry.name + ' · ' + entry.messageCount + ' 条消息' + (entry.hasDraft ? ' · 有未发送草稿' : '') + (entry.active ? ' · 当前' : '') + ' · ' + entry.updatedAt),
        button('查看讨论', () => { if (!requireView(state)) return; try { state.archiveReadSeq = (state.archiveReadSeq || 0) + 1; const value = current.manager.snapshot(entry.id); preview(state, { ...archivePayload(value, entry.name), revision: null }, entry.id); } catch (error) { showNotice(state, '讨论预览失败：' + error.message, true); } }));
      list.append(row);
    });
    const found = scanBrowser(), others = found.records.filter(record => record.projectId !== current.projectId || record.moduleId !== moduleId || record.sourceType !== 'workspace');
    recovered.append(element('h3', '其他任务与旧版快照'));
    if (!others.length) recovered.append(element('p', '在这个浏览器的同一网址中，暂未找到其他非空讨论。其他浏览器、其他网址或端口、已清除的存储不会自动出现在这里。下方仍可检查本机备份和旧核查片段。', 'codex-status'));
    others.forEach(record => {
      const row = element('div', undefined, 'literature-discussion-row');
      row.append(element('span', record.name + ' · ' + record.snapshot.messages.length + ' 条消息 · ' + (record.updatedAt || '时间未记录') + ' · 来源 ' + record.sourceKey),
        button('查看找到的讨论', () => { state.archiveReadSeq = (state.archiveReadSeq || 0) + 1; preview(state, record); })); recovered.append(row);
    });
    if (found.errors.length) recovered.append(element('p', '部分旧存储未能读取，原记录未改动：' + found.errors.join('；'), 'codex-error'));
    void loadRecoveries(state, recovery);
    remote.append(element('h3', '本机服务保存的版本'), element('p', '正在读取版本列表…', 'codex-status'));
    try {
      const params = new URLSearchParams({ projectId: state.projectId, moduleId });
      const result = await request('/api/literature/discussions?' + params); if (!currentView(state)) return;
      remote.replaceChildren(element('h3', '本机服务保存的版本'));
      if (!result.discussions?.length) remote.append(element('p', '暂未发现本机备份；浏览器已有讨论正在逐份备份。', 'codex-status'));
      (result.discussions || []).forEach(entry => {
        const details = element('details'); details.append(element('summary', entry.name + ' · 最新 ' + entry.messageCount + ' 条消息 · ' + entry.updatedAt));
        (entry.versions || [entry]).slice().reverse().forEach(version => {
          const row = element('div', undefined, 'literature-discussion-row'); row.append(element('span', '版本 ' + version.revision + ' · ' + version.messageCount + ' 条消息' + (version.hasDraft ? ' · 有草稿' : '') + ' · ' + version.updatedAt), button('查看此版本', () => loadArchive(state, version))); details.append(row);
        }); remote.append(details);
      });
    } catch (error) { if (currentView(state)) remote.append(element('p', '本机备份列表读取失败：' + error.message + '。上方浏览器讨论仍可查看和返回。', 'codex-error')); }
  }
  function returnOrigin(moduleId) {
    const current = scope(moduleId), origin = current?.manager.captureCurrent().snapshot.client.literatureDiscussionOrigin;
    if (!current || !origin || origin.projectId !== current.projectId) return open(moduleId);
    const result = current.manager.switch(origin.workspaceId);
    if (!result.ok) { setStatus(current.key, result.error, true); return; }
    root.CodexUI?.renderLiteratureWorkspace?.(moduleId); save(moduleId, true);
  }
  function status(moduleId) { const current = scope(moduleId); return current ? states.get(current.key) || { text: '讨论保存在当前浏览器；可查看讨论记录或立即保存。', error: false } : { text: '', error: false }; }
  root.LiteratureDiscussions = { open, save, schedule, restoreComposer, returnOrigin, status, archivePayload, scanBrowser };
  root.Store?.subscribe(event => {
    if (projectSwitching) return;
    const state = root.Store.getState(), mod = state.modules.find(item => item.id === state.activeModuleId);
    if (mod?.type !== 'literature-mining') { activeModule = state.activeModuleId; return; }
    const entered = activeModule !== mod.id;
    if (entered) { root.ModuleSpace?.resetContext?.(mod.id, null); activeModule = mod.id; }
    const current = scope(mod.id); if (!current || current.manager.isChanging?.()) return;
    if (!booted.has(current.projectId + ':' + mod.id)) seedProject(mod.id);
    if (entered) restoreComposer(mod.id);
    if (event.type === 'message:append' || /doc|state:reset/.test(event.type)) schedule(mod.id);
  });
  root.addEventListener('discussion-draft-change', event => schedule(event.detail?.moduleId));
  root.addEventListener('discussion-project-before-switch', event => {
    const mod = root.Store.getState().modules.find(item => item.id === root.Store.getState().activeModuleId);
    if (mod?.type === 'literature-mining' && !save(mod.id, true).ok) { event.preventDefault(); return; }
    projectSwitching = true;
  });
  root.addEventListener('discussion-project-after-switch', () => {
    projectSwitching = false;
    const mod = root.Store.getState().modules.find(item => item.id === root.Store.getState().activeModuleId);
    if (mod?.type === 'literature-mining') { root.ModuleSpace?.resetContext?.(mod.id, null); activeModule = mod.id; seedProject(mod.id); restoreComposer(mod.id); }
  });
  root.addEventListener('discussion-project-switch-cancelled', () => { projectSwitching = false; });
  root.addEventListener('literature-workspace-change', event => { if (!projectSwitching) schedule(event.detail?.moduleId); });
  root.addEventListener('beforeunload', () => {
    const mod = root.Store.getState().modules.find(item => item.id === root.Store.getState().activeModuleId);
    if (mod?.type === 'literature-mining') save(mod.id, true);
  });
  const initial = root.Store?.getState(), mod = initial?.modules.find(item => item.id === initial.activeModuleId);
  if (mod?.type === 'literature-mining') { activeModule = mod.id; seedProject(mod.id); }
})(window);
