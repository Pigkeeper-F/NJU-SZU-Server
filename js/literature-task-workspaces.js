/* Named literature subtasks inside the current project. No network operations. */
(function (root) {
  'use strict';
  const KEY = 'research_literature_workspaces_v1';
  const DOCS = 'fa_doc_history_v1';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const emptyRules = () => ({ draft: '', confirmed: '', versions: [] });
  const stamp = () => new Date().toISOString();
  function read(key, fallback) {
    const raw = root.localStorage.getItem(key);
    if (raw == null) return copy(fallback);
    const value = JSON.parse(raw);
    if (!object(value)) throw new Error('本地文献任务记录无法读取，原记录保留，请先备份。');
    return value;
  }
  function write(key, value) { root.localStorage.setItem(key, JSON.stringify(value)); }
  function createManager(options) {
    const moduleId = options.moduleId, adapter = options.adapter || {};
    let changing = false, stagedId = null;
    function projectId() {
      const id = root.TaskManager?.currentTaskId?.();
      if (typeof id !== 'string' || !id) throw new Error('项目尚未载入，请稍后再新建文献任务。');
      return id;
    }
    function bucketKey() { return projectId() + ':' + moduleId; }
    function module() {
      const mod = root.Store.getState().modules.find(item => item.id === moduleId);
      if (!mod || mod.type !== 'literature-mining') throw new Error('当前项目的文献挖掘模块不存在。');
      return mod;
    }
    function busy() {
      return changing || !!adapter.isBusy?.() || !!root.ModuleSpace?.isBusy?.() || !!root.LiteratureUI?.isBusy?.();
    }
    function capture() {
      const docs = read(DOCS, {});
      return {
        module: copy(module()), client: copy(adapter.snapshotClient?.() || {}),
        docHistory: copy(docs[moduleId] || []),
        legacy: copy(root.LiteratureUI?.snapshotContext?.(moduleId) || null),
        rules: copy(root.TaskManager?.snapshotModuleRules?.(moduleId) || null),
        chat: copy(root.ModuleSpace?.snapshotContext?.(moduleId) || null)
      };
    }
    function registry() {
      const value = read(KEY, { version: 1, projects: {} });
      if (value.version !== 1 || !object(value.projects)) throw new Error('文献任务目录格式有误，旧记录未改动。');
      return value;
    }
    function view(context) {
      return context ? { id: context.id, name: context.name, mode: context.mode, createdAt: context.createdAt,
        updatedAt: context.updatedAt, jobId: context.snapshot?.client?.literatureJobId || null,
        messageCount: context.snapshot?.module?.messages?.length || 0,
        hasDraft: !!(context.snapshot?.chat?.composer || context.snapshot?.chat?.draftText),
        active: false } : null;
    }
    function rememberSnapshot(context, snapshot) {
      context.snapshot = snapshot; context.updatedAt = stamp();
      const mode = snapshot.client?.literatureConfig?.searchMode;
      if (mode === 'test' || mode === 'formal') context.mode = mode;
    }
    function selectedId(bucket) { return changing && stagedId ? stagedId : bucket.activeId; }
    function recoverPending(value, bucket) {
      if (!bucket.pendingSwitch || changing) return;
      if (busy()) throw new Error('上次文献任务切换未完成；请等待当前处理结束，再恢复旧任务。');
      const old = bucket.contexts.find(item => item.id === bucket.pendingSwitch.fromId);
      if (!old?.snapshot || bucket.activeId !== old.id) throw new Error('上次切换记录不完整，原任务快照保留，请先备份。');
      const snapshot = copy(old.snapshot), state = root.Store.getState();
      const position = state.modules.findIndex(item => item.id === moduleId);
      if (position < 0 || snapshot.module?.id !== moduleId) throw new Error('无法恢复旧文献任务，原快照仍保留。');
      const docs = read(DOCS, {}); docs[moduleId] = snapshot.docHistory || [];
      state.modules[position] = snapshot.module;
      changing = true; stagedId = old.id;
      try {
        write(DOCS, docs); write('fa_state_v1', state); write('research_task_state_' + projectId(), state);
        restoreSideEffects(snapshot, true);
        if (!root.Store.restoreState(state)) throw new Error('旧任务恢复失败，原快照仍保留。');
        delete bucket.pendingSwitch;
        write(KEY, value);
      } catch (error) { throw new Error('上次切换未完成，恢复旧任务时遇到问题：' + error.message + ' 请保留当前页面。'); }
      finally { changing = false; stagedId = null; }
    }
    function ensure() {
      try {
        const value = registry(), key = bucketKey();
        if (!value.projects[key]) {
          const original = capture(), config = original.client.literatureConfig || {};
          const now = stamp(), id = 'lit_' + (root.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
          const context = { id, name: config.topic ? String(config.topic).slice(0, 80) + '（原有任务）' : '原有文献任务',
            mode: config.searchMode === 'formal' ? 'formal' : 'test', createdAt: now, updatedAt: now, snapshot: original };
          value.projects[key] = { projectId: projectId(), moduleId, activeId: id, contexts: [context] };
          write(KEY, value);
        }
        const bucket = value.projects[key];
        if (!object(bucket) || !Array.isArray(bucket.contexts) || !bucket.contexts.some(item => item?.id === bucket.activeId && object(item.snapshot))) {
          throw new Error('文献任务目录不完整，原任务仍保留，未新建或切换。');
        }
        recoverPending(value, bucket);
        return { ok: true, context: { ...view(bucket.contexts.find(item => item.id === selectedId(bucket))), active: true } };
      } catch (error) { return { ok: false, error: error.message }; }
    }
    function active() { const result = ensure(); return result.ok ? result.context : null; }
    function list() {
      const ready = ensure();
      if (!ready.ok) return [];
      const bucket = registry().projects[bucketKey()];
      return bucket.contexts.map(item => ({ ...view(item), active: item.id === selectedId(bucket) }));
    }
    function saveActive() {
      if (changing) return { ok: false, error: '文献任务正在切换，稍后再保存。' };
      const ready = ensure();
      if (!ready.ok) return ready;
      try {
        const value = registry(), bucket = value.projects[bucketKey()];
        const item = bucket.contexts.find(item => item.id === bucket.activeId);
        const next = capture();
        // A stale/empty project mirror must not erase the only stored discussion.
        // Keep this as a recovery source, never as an executable task binding.
        if (item.snapshot?.module?.messages?.length && !next.module.messages?.length) {
          bucket.discussionBackups ||= [];
          bucket.discussionBackups.push({ id: 'discussion_' + (root.crypto?.randomUUID?.() || Date.now().toString(36)),
            name: item.name + ' · 空白覆盖前的原讨论', savedAt: stamp(), workspaceId: item.id, snapshot: copy(item.snapshot) });
        }
        rememberSnapshot(item, next);
        write(KEY, value);
        return { ok: true, context: { ...view(item), active: true } };
      } catch (error) { return { ok: false, error: '文献任务尚未保存：' + error.message }; }
    }
    function restoreSideEffects(snapshot, rollback = false) {
      const errors = [];
      const steps = [
        [() => root.LiteratureUI?.restoreContext?.(moduleId, copy(snapshot.legacy)), '旧版文献记录未能可靠保存，未切换任务。'],
        [() => root.TaskManager?.restoreModuleRules?.(moduleId, copy(snapshot.rules)), '规则记录未能可靠保存，未切换任务。'],
        [() => adapter.applyClient?.(copy(snapshot.client)), '文献配置未能可靠保存，未切换任务。'],
        [() => adapter.resetChat ? adapter.resetChat(copy(snapshot.chat)) : root.ModuleSpace?.resetContext?.(moduleId, copy(snapshot.chat)), '当前讨论仍在处理中，未切换任务。']
      ];
      for (const [apply, message] of steps) {
        try { if (apply() === false) throw new Error(message); }
        catch (error) { if (!rollback) throw error; errors.push(error.message); }
      }
      if (errors.length) throw new Error(errors.join('；'));
    }
    function transition(makeTarget, forceRestore = false) {
      if (busy()) return { ok: false, error: '当前有任务正在处理，请等待或停止后再新建、切换文献任务。' };
      const ready = ensure();
      if (!ready.ok) return ready;
      let original, oldState, oldRaw, sideEffectsStarted = false;
      try {
        adapter.closeDialogs?.();
        if (busy()) throw new Error('当前任务仍在保存或处理中，未切换。');
        original = capture(); oldState = root.Store.getState();
        const id = projectId(), key = bucketKey(), value = registry(), bucket = value.projects[key];
        const previous = bucket.contexts.find(item => item.id === bucket.activeId);
        rememberSnapshot(previous, original);
        const target = makeTarget(bucket, original);
        if (!target) throw new Error('找不到这个文献任务，原任务未改动。');
        if (target.id === bucket.activeId && !forceRestore) return { ok: true, context: { ...view(target), active: true }, noop: true };
        const snapshot = copy(target.snapshot), nextState = copy(oldState);
        const position = nextState.modules.findIndex(item => item.id === moduleId);
        if (position < 0 || snapshot.module?.id !== moduleId) throw new Error('文献任务与当前模块不匹配。');
        nextState.modules[position] = snapshot.module;
        const docs = read(DOCS, {}); docs[moduleId] = snapshot.docHistory || [];
        bucket.pendingSwitch = { fromId: bucket.activeId, toId: target.id, at: stamp() };
        const keys = [KEY, DOCS, 'fa_state_v1', 'research_task_state_' + id, 'research_literature_runs_v1', 'research_tasks_v1', 'research_codex_tasks_v1'];
        oldRaw = keys.map(key => [key, root.localStorage.getItem(key)]);
        changing = true; stagedId = target.id;
        // Persist the old snapshot and new selection before mutating live state.
        // Any failure rolls these writes back and keeps the previous selection.
        write(KEY, value); write(DOCS, docs);
        write('fa_state_v1', nextState); write('research_task_state_' + id, nextState);
        sideEffectsStarted = true;
        restoreSideEffects(snapshot);
        if (projectId() !== id) throw new Error('项目已变化，未切换文献任务。');
        if (!root.Store.restoreState(nextState)) throw new Error('文献任务状态无法载入，旧记录保留。');
        if (forceRestore) rememberSnapshot(bucket.contexts.find(item => item.id === target.id), snapshot);
        bucket.activeId = target.id; delete bucket.pendingSwitch;
        write(KEY, value);
        return { ok: true, context: { ...view(target), active: true } };
      } catch (error) {
        const failures = [];
        if (sideEffectsStarted && original) {
          try { restoreSideEffects(original, true); } catch (rollbackError) { failures.push(rollbackError.message); }
          try { if (oldState) root.Store.restoreState(oldState); } catch (rollbackError) { failures.push(rollbackError.message); }
        }
        if (oldRaw) oldRaw.slice().reverse().forEach(([key, raw]) => {
          try { if (raw === null) root.localStorage.removeItem(key); else root.localStorage.setItem(key, raw); }
          catch (rollbackError) { failures.push(rollbackError.message); }
        });
        return { ok: false, error: '未切换文献任务：' + error.message + (failures.length ? ' 请保留当前页面并备份已有记录。' : '') };
      } finally {
        changing = false; stagedId = null;
        if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent('literature-workspace-change', { detail: { moduleId } }));
      }
    }
    function create(input = {}) {
      const name = String(input.name || '').trim();
      if (!name || name.length > 80) return { ok: false, error: '文献任务名称须为 1 到 80 个字。' };
      if (input.mode !== undefined && !['test', 'formal'].includes(input.mode)) return { ok: false, error: '请选择测试或正式模式。' };
      return transition((bucket, original) => {
        const now = stamp(), mod = copy(original.module);
        mod.messages = []; mod.doc = null; mod.run = null; mod.status = 'todo'; mod.params = {};
        delete mod.approvedAt;
        if (input.seedDoc) {
          const content = typeof input.seedDoc === 'string' ? input.seedDoc : input.seedDoc.content;
          if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new Error('复用的规则文档无效。');
          mod.doc = { content, status: 'draft', updatedAt: now, approvedAt: null };
        }
        const discussion = input.discussion;
        if (discussion) {
          if (!Array.isArray(discussion.messages) || !discussion.messages.every(message => message && ['user', 'assistant', 'system'].includes(message.role) && typeof message.text === 'string' && message.text.length <= 20000)) throw new Error('讨论存档的消息格式无效，未恢复。');
          mod.messages = copy(discussion.messages);
          if (discussion.approvedDoc?.content) mod.doc = { ...copy(discussion.approvedDoc), status: 'draft', approvedAt: null };
        }
        const client = copy(input.seedClient || {});
        // Session, output, candidate, and approval bindings can never be seeded.
        const allowed = ['backend', 'model', 'literatureConfig', 'literatureUntil', 'literatureConfigOpen', 'literatureSource'];
        for (const key of Object.keys(client)) if (!allowed.includes(key)) delete client[key];
        if (client.literatureConfig) {
          delete client.literatureConfig.confirmations;
          if (client.literatureConfig.extraction) delete client.literatureConfig.extraction.fieldsConfirmed;
        }
        const context = { id: 'lit_' + (root.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)),
          name, mode: input.mode || 'test', createdAt: now, updatedAt: now,
          snapshot: { module: mod, client, docHistory: [], legacy: null,
            rules: discussion ? { draft: discussion.rules?.draft || discussion.rules?.confirmed || '', confirmed: '', versions: [] } : emptyRules(),
            chat: discussion ? { composer: discussion.composer || '', editing: discussion.docEditing === true, draftText: discussion.docDraftText || '' } : null } };
        bucket.contexts.push(context);
        return context;
      });
    }
    function switchContext(id) { return transition(bucket => bucket.contexts.find(item => item.id === id)); }
    function snapshot(id) {
      const ready = ensure(); if (!ready.ok) throw new Error(ready.error);
      const bucket = registry().projects[bucketKey()], workspaceId = id || bucket.activeId;
      const context = bucket.contexts.find(item => item.id === workspaceId); if (!context) throw new Error('找不到原讨论工作区，已有记录未改动。');
      const value = workspaceId === bucket.activeId ? capture() : copy(context.snapshot);
      value.client ||= {};
      // Revision envelopes must not recursively embed every earlier branch.
      delete value.client.literatureRevisionOriginal; delete value.client.literatureRevisionDraft;
      return { version: 1, projectId: projectId(), moduleId, workspaceId, snapshot: value };
    }
    function restoreCurrent(envelope) {
      const ready = ensure(); if (!ready.ok) return ready;
      if (envelope?.version !== 1 || envelope.projectId !== projectId() || envelope.moduleId !== moduleId || envelope.workspaceId !== ready.context.id
        || envelope.snapshot?.module?.id !== moduleId || !object(envelope.snapshot.client)) return { ok: false, error: '讨论备份不属于当前项目、模块或文献工作区，未恢复。' };
      return transition(bucket => ({ ...copy(bucket.contexts.find(item => item.id === bucket.activeId)), snapshot: copy(envelope.snapshot) }), true);
    }
    function storedSnapshot(id) {
      const ready = ensure(); if (!ready.ok) throw new Error(ready.error);
      const context = registry().projects[bucketKey()].contexts.find(item => item.id === (id || ready.context.id));
      if (!context) throw new Error('找不到这份讨论记录。');
      return { version: 1, projectId: projectId(), moduleId, workspaceId: context.id, snapshot: copy(context.snapshot) };
    }
    return { ensure, active, list, create, switch: switchContext, saveActive, busy, snapshot, storedSnapshot, captureCurrent: () => snapshot(), restoreCurrent, isChanging: () => changing };
  }
  function discoverStored() {
    const records = [], errors = [];
    try {
      const value = read(KEY, { version: 1, projects: {} });
      if (value.version !== 1 || !object(value.projects)) throw new Error('文献工作区目录格式无效');
      Object.entries(value.projects).forEach(([key, bucket]) => {
        if (!object(bucket) || !Array.isArray(bucket.contexts)) { errors.push(key + '：目录不完整'); return; }
        bucket.contexts.forEach(context => {
          const add = (snapshot, suffix, label) => {
            if (!snapshot?.module || !Array.isArray(snapshot.module.messages)) return;
            if (!snapshot.module.messages.length && !snapshot.chat?.composer && !snapshot.chat?.draftText) return;
            records.push({ name: (context.name || '文献讨论') + label, projectId: bucket.projectId || key.slice(0, key.lastIndexOf(':')),
              moduleId: bucket.moduleId || snapshot.module.id, workspaceId: context.id + (suffix ? ':' + suffix : ''), sourceKey: KEY, sourceType: suffix || 'workspace', updatedAt: context.updatedAt,
              envelope: { version: 1, projectId: bucket.projectId || key.slice(0, key.lastIndexOf(':')), moduleId: bucket.moduleId || snapshot.module.id, workspaceId: context.id + (suffix ? ':' + suffix : ''), snapshot: copy(snapshot) } });
          };
          add(context.snapshot, '', '');
          add(context.snapshot?.client?.literatureRevisionOriginal?.context?.snapshot, 'revision-original', ' · 原讨论备份');
          add(context.snapshot?.client?.literatureRevisionDraft?.context?.snapshot, 'revision-draft', ' · 修改草稿讨论备份');
        });
        (bucket.discussionBackups || []).forEach(backup => {
          if (!Array.isArray(backup.snapshot?.module?.messages) || !backup.snapshot.module.messages.length) return;
          const projectId = bucket.projectId || key.slice(0, key.lastIndexOf(':')), moduleId = bucket.moduleId || backup.snapshot.module.id;
          records.push({ name: backup.name || '原讨论备份', projectId, moduleId, workspaceId: backup.id, sourceKey: KEY,
            sourceType: 'empty-overwrite-backup', updatedAt: backup.savedAt,
            envelope: { version: 1, projectId, moduleId, workspaceId: backup.id, snapshot: copy(backup.snapshot) } });
        });
      });
    } catch (error) { errors.push(KEY + '：' + error.message); }
    return { records, errors };
  }
  root.LiteratureTaskWorkspaces = { createManager, storageKey: KEY, discoverStored };
  if (root.TaskManager?.currentTaskId?.() && root.CodexUI?.render) root.CodexUI.render();
})(typeof window !== 'undefined' ? window : this);
