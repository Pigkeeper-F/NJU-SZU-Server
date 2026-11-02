/* 独立研究任务：隔离模块会话，并保存研究者确认的执行规则。 */
;(function (root) {
  'use strict';

  var INDEX_KEY = 'research_tasks_v1';
  var STATE_PREFIX = 'research_task_state_';
  var $ = function (id) { return document.getElementById(id); };
  var memory = {};
  var switching = false;
  var pendingRules = null;
  var startingExecution = null;
  var cleanVerificationStage = null;
  var index;
  var bootstrapMessage = '';
  var blockedBootstrapProject = null;
  var BOOTSTRAP_BACKUPS_KEY = 'research_task_bootstrap_backups_v1';

  function read(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return memory[key] || null; }
  }
  function write(key, value) {
    memory[key] = value;
    try { root.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function id() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); }
  function current() { return index.tasks.filter(function (task) { return task.id === index.activeTaskId; })[0]; }
  function saveIndex() { return write(INDEX_KEY, JSON.stringify(index)); }
  function saveState() {
    if (blockedBootstrapProject === index.activeTaskId) return false;
    return write(STATE_PREFIX + index.activeTaskId, JSON.stringify(root.Store.getState()));
  }
  function readState(taskId) {
    try { return JSON.parse(read(STATE_PREFIX + taskId)); } catch (e) { return null; }
  }
  function showMessage(value) { $('task-summary-message').textContent = value || ''; }
  function discussionProjectEvent(type, targetId) {
    var EventType = root.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (!EventType || typeof document.dispatchEvent !== 'function') return true;
    return document.dispatchEvent(new EventType(type, { bubbles: true, cancelable: type === 'discussion-project-before-switch',
      detail: { projectId: index.activeTaskId, targetProjectId: targetId || index.activeTaskId } }));
  }
  function busy() { return !!(root.ModuleSpace && root.ModuleSpace.isBusy()); }
  function isModification(mod) { return !!mod && mod.type === 'calculation' && mod.mode === 'modify'; }
  function isPlotting(mod) { return !!mod && mod.type === 'plotting'; }
  function hasEditableRules(mod) { return !!mod && (mod.type === 'clean-data' || isModification(mod) || isPlotting(mod)); }
  function refreshControls() {
    if (switching) return;
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    var rules = rulesFor(current());
    var isDownload = !!mod && mod.type === 'download-data';
    var visible = !!mod && (isDownload || hasEditableRules(mod) || mod.type === 'result-audit');
    var confirmed = isDownload ? confirmedRules() : rules.confirmed;
    var changed = hasEditableRules(mod) && rules.draft.trim() !== rules.confirmed;
    var processing = busy();
    var reason = startingExecution ? '正在核对输入文件并准备执行，请等待。'
      : pendingRules ? 'AI 正在提取候选规则，请等待完成后核对并确认。'
      : processing ? '当前有 AI 或文件任务正在处理，完成后执行按钮会自动恢复。'
      : !visible || mod.type === 'result-audit' ? '请在对应模块继续操作。'
      : !confirmed ? '请先确认规则，再执行任务。'
      : changed ? '草稿已修改，请先重新确认；本次不会按旧规则执行。'
      : mod?.type === 'clean-data' && root.CleanExecutionPlan?.prepare(confirmed)?.binding
        ? '80条数据的输入版本和异常处理已明确，可直接执行清洗、自动核验和导出；人工签认另行保留待办。'
        : '准备就绪，可按已确认版本执行；规则中尚未确定的处理口径会先在对话中询问。';
    $('task-summary-ai').disabled = !!pendingRules || processing || !!startingExecution;
    $('task-rules-discuss').disabled = !!pendingRules || processing || !!startingExecution;
    $('task-rules-discuss').hidden = !hasEditableRules(mod) && (!mod || mod.type !== 'result-audit');
    $('task-summary-save').disabled = !!pendingRules || processing || !!startingExecution;
    $('task-summary-history').disabled = !(rules.versions || []).length || !!startingExecution;
    $('task-rules-execute').disabled = !confirmed || !visible || mod.type === 'result-audit' || !!pendingRules || processing || !!startingExecution || changed;
    $('task-rules-execute').title = reason;
    $('task-rules-execute').setAttribute('aria-describedby', 'task-rules-execution-status');
    $('task-rules-execution-status').textContent = reason;
    if (hasEditableRules(mod)) $('task-summary-status').textContent = confirmed && changed ? '草稿已修改 · 待重新' + (isModification(mod) || isPlotting(mod) ? '审核' : '确认') : confirmed ? (isModification(mod) || isPlotting(mod) ? '已审核 v' : '已确认 v') + rules.versions.length : '尚未确认';
  }
  function previousPlan(mod, rules) {
    var dialog = $('rules-dialog');
    var panel = dialog.querySelector('.task-previous-plan');
    if (!panel) {
      panel = document.createElement('details');
      panel.className = 'task-previous-plan';
      dialog.appendChild(panel);
    }
    panel.hidden = !(isModification(mod) || isPlotting(mod)) || !mod.doc || !mod.doc.content || mod.doc.content === rules.confirmed;
    if (panel.hidden) return;
    panel.replaceChildren();
    var summary = document.createElement('summary');
    summary.textContent = '以前单独保存的方案（仅供核对）';
    var description = document.createElement('p');
    description.textContent = '原方案保留在这里。复制到草稿并审核通过后，才作为本次执行依据。';
    var content = document.createElement('div');
    content.className = 'doc-content';
    content.textContent = mod.doc.content;
    var copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'quiet-button';
    copy.textContent = '将原方案放入草稿'; copy.disabled = busy() || !!pendingRules;
    copy.addEventListener('click', function () {
      rulesFor(current(), mod.id).draft = mod.doc.content;
      saveIndex();
      showMessage('原方案已复制到草稿，请核对后点击“审核通过方案”。');
      render();
    });
    panel.append(summary, description, content, copy);
  }
  function rulesFor(task, moduleId) {
    moduleId = moduleId || root.Store.getState().activeModuleId;
    if (!moduleId) return { draft: '', confirmed: '', versions: [] };
    task.rulesByModule = task.rulesByModule || {};
    if (!task.rulesByModule[moduleId]) {
      var mod = root.Store.getState().modules.filter(function (item) { return item.id === moduleId; })[0];
      // 上一版的任务级规则只迁到原数据清洗模块；旧摘要不自动升级。
      var old = mod && mod.type === 'clean-data' && task.rules;
      task.rulesByModule[moduleId] = old ? JSON.parse(JSON.stringify(old)) : { draft: '', confirmed: '', versions: [] };
      saveIndex();
    }
    return task.rulesByModule[moduleId];
  }

  function bootstrapSnapshot(raw) {
    if (typeof raw !== 'string') return null;
    try {
      var value = JSON.parse(raw), seen = {};
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.modules)) return null;
      if (!value.modules.every(function (mod) {
        if (!mod || typeof mod.id !== 'string' || !mod.id || seen[mod.id] || mod.messages != null && !Array.isArray(mod.messages)) return false;
        seen[mod.id] = true;
        if (!(mod.messages || []).every(function (message) {
          return message && typeof message.text === 'string' && ['user', 'assistant', 'system'].indexOf(message.role) >= 0;
        })) return false;
        return !mod.doc || typeof mod.doc.content === 'string' && mod.doc.content.length <= 20000 && ['draft', 'approved'].indexOf(mod.doc.status) >= 0;
      })) return null;
      return value;
    } catch (_) { return null; }
  }
  function bootstrapCanonical(value) {
    if (Array.isArray(value)) return value.map(bootstrapCanonical);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce(function (result, key) { result[key] = bootstrapCanonical(value[key]); return result; }, {});
    return value;
  }
  function bootstrapEqual(one, two) { return JSON.stringify(bootstrapCanonical(one)) === JSON.stringify(bootstrapCanonical(two)); }
  function bootstrapClock(state) {
    var latest = 0;
    function include(value) { var time = Date.parse(value); if (isFinite(time)) latest = Math.max(latest, time); }
    (state.modules || []).forEach(function (mod) {
      include(mod.createdAt); include(mod.doc && mod.doc.updatedAt); include(mod.run && mod.run.at);
      (mod.messages || []).forEach(function (message) { include(message.at); });
    });
    return latest;
  }
  function bootstrapProjectMoreComplete(mirror, project) {
    if (mirror.modules.length !== project.modules.length || bootstrapClock(project) < bootstrapClock(mirror)) return false;
    var longer = false;
    for (var i = 0; i < mirror.modules.length; i++) {
      var current = mirror.modules[i], stored = project.modules[i];
      if (current.id !== stored.id) return false;
      var currentMessages = current.messages || [], storedMessages = stored.messages || [];
      if (currentMessages.length > storedMessages.length || !currentMessages.every(function (message, n) { return bootstrapEqual(message, storedMessages[n]); })) return false;
      if (storedMessages.length > currentMessages.length) longer = true;
      if (!bootstrapEqual(current.doc || null, stored.doc || null)) {
        if (!stored.doc || current.doc && !(Date.parse(stored.doc.updatedAt) > Date.parse(current.doc.updatedAt))) return false;
        longer = true;
      }
      var currentOther = JSON.parse(JSON.stringify(current)), storedOther = JSON.parse(JSON.stringify(stored));
      delete currentOther.messages; delete storedOther.messages; delete currentOther.doc; delete storedOther.doc;
      if (!bootstrapEqual(currentOther, storedOther)) return false;
    }
    var mirrorOther = JSON.parse(JSON.stringify(mirror)), projectOther = JSON.parse(JSON.stringify(project));
    delete mirrorOther.modules; delete projectOther.modules;
    return longer && bootstrapEqual(mirrorOther, projectOther);
  }
  function preserveBootstrapOriginals(projectId, mirrorRaw, projectRaw, reason) {
    var raw = read(BOOTSTRAP_BACKUPS_KEY), backups;
    try { backups = raw == null ? { version: 1, entries: [] } : JSON.parse(raw); }
    catch (_) { return false; }
    if (!backups || backups.version !== 1 || !Array.isArray(backups.entries)) return false;
    var sources = [{ key: 'fa_state_v1', raw: mirrorRaw }, { key: STATE_PREFIX + projectId, raw: projectRaw }];
    if (backups.entries.some(function (entry) { return entry.projectId === projectId && bootstrapEqual(entry.sources, sources); })) return true;
    backups.entries.push({ id: id(), projectId: projectId, reason: reason, savedAt: new Date().toISOString(), sources: sources });
    // This backup must be durable before either original key may be replaced.
    // The ordinary memory fallback cannot establish that guarantee.
    try { root.localStorage.setItem(BOOTSTRAP_BACKUPS_KEY, JSON.stringify(backups)); memory[BOOTSTRAP_BACKUPS_KEY] = JSON.stringify(backups); return true; }
    catch (_) { return false; }
  }
  function recoverBootstrapState(fresh) {
    if (fresh) return true;
    var projectId = index.activeTaskId, mirrorRaw = read('fa_state_v1'), projectRaw = read(STATE_PREFIX + projectId);
    var mirror = bootstrapSnapshot(mirrorRaw), project = bootstrapSnapshot(projectRaw);
    if (projectRaw == null || mirrorRaw === projectRaw || mirror && project && bootstrapEqual(mirror, project)) return true;
    var restoreProject = !!project && (!mirror || bootstrapProjectMoreComplete(mirror, project));
    var reason = restoreProject ? '项目独立记录比当前镜像完整或镜像不可读取' : '启动时镜像与项目独立记录不同；保留两份原文，不合并讨论';
    if (!preserveBootstrapOriginals(projectId, mirrorRaw, projectRaw, reason)) {
      blockedBootstrapProject = projectId;
      bootstrapMessage = '启动时发现两份不同记录，但原文备份未能可靠保存；旧项目记录未覆盖。请保留页面，先下载备份并检查浏览器存储空间。';
      return false;
    }
    if (restoreProject) {
      if (!root.Store.restoreState(project)) {
        blockedBootstrapProject = projectId;
        bootstrapMessage = '项目独立记录未能载入；两份原文已经备份，旧项目记录未覆盖。请在讨论记录中核对恢复来源。';
        return false;
      }
      bootstrapMessage = '已恢复项目保存的完整讨论与方案；启动前两份原文均已备份，可在讨论记录中核对。';
    } else bootstrapMessage = '检测到不同的启动记录：当前镜像继续使用，两份原文均已备份；可在讨论记录中查找旧讨论，未合并或确认任何新规则。';
    return true;
  }

  function initialize() {
    try { index = JSON.parse(read(INDEX_KEY)); } catch (e) { index = null; }
    var fresh = !index || !Array.isArray(index.tasks) || !index.tasks.length || !index.tasks.some(function (task) { return task.id === index.activeTaskId; });
    if (fresh) {
      var first = { id: id(), name: '原有练习', createdAt: new Date().toISOString(), rulesByModule: {} };
      index = { activeTaskId: first.id, tasks: [first] };
      saveIndex();
    }
    recoverBootstrapState(fresh);
    // 贡献版使用 fa_projects_v1 存多项目；一次性映射为本工作台的独立任务，保留原键作备份。
    if (!read('research_legacy_projects_imported_v1')) {
      var legacyProjects;
      try { legacyProjects = JSON.parse(read('fa_projects_v1')); } catch (e) { legacyProjects = null; }
      if (Array.isArray(legacyProjects) && legacyProjects.length) {
        var currentProjectId = read('fa_current_project_id_v1');
        if (fresh) {
          try {
            var meta = JSON.parse(read('research_workspace_meta_v1'));
            if (meta && typeof meta.name === 'string' && meta.name.trim()) index.tasks[0].name = meta.name.trim().slice(0, 80);
          } catch (e) { /* 沿用原有练习名称 */ }
        }
        legacyProjects.forEach(function (project) {
          if (!project || typeof project.id !== 'string' || project.id === currentProjectId || !Array.isArray(project.modules)) return;
          var taskId = id();
          var task = {
            id: taskId,
            name: ((typeof project.name === 'string' && project.name.trim()) ? project.name.trim() : '旧项目').slice(0, 80),
            createdAt: project.savedAt || new Date().toISOString(),
            rulesByModule: {}
          };
          var snapshot = root.Store.getState();
          snapshot.modules = project.modules;
          snapshot.activeModuleId = project.activeModuleId || null;
          if (write(STATE_PREFIX + taskId, JSON.stringify(snapshot))) index.tasks.push(task);
        });
        saveIndex();
        write('research_legacy_projects_imported_v1', '1');
      }
    }
    // fa_state_v1 始终是当前任务的最新镜像。首次升级时原有记录直接归入“原有练习”。
    saveState();
  }

  function render() {
    var select = $('task-select');
    var selected = index.activeTaskId;
    select.replaceChildren();
    index.tasks.forEach(function (task) {
      var option = document.createElement('option');
      option.value = task.id;
      option.textContent = task.name;
      select.appendChild(option);
    });
    select.value = selected;
    var active = root.Store.getState();
    var mod = active.modules.filter(function (item) { return item.id === active.activeModuleId; })[0];
    var isAudit = !!mod && mod.type === 'result-audit';
    var isDownload = !!mod && mod.type === 'download-data';
    var isModify = isModification(mod);
    var isPlot = isPlotting(mod);
    var rulesVisible = !!mod && (isDownload || mod.type === 'clean-data' || isModify || isPlot || isAudit);
    $('task-summary').hidden = !rulesVisible;
    $('task-summary').firstElementChild.textContent = isAudit ? '核查原则' : isDownload ? '下载规则' : '执行规则';
    $('task-rules-open').textContent = isAudit ? '查看 / 编辑核查原则' : isDownload ? '查看 / 编辑下载规则' : '查看 / 编辑规则';
    $('rules-dialog').querySelector('h2').textContent = isAudit ? '核查原则' : isDownload ? '下载规则' : '执行规则';
    $('rules-dialog').querySelector('p').textContent = isAudit ? '保存你确定采用的核查对象、指标、阈值和通过条件。可自行填写，或从讨论中提取候选原则；确认后作为核查依据。已有标准也可在模块中直接上传。' : '这里只放你决定要执行的规则。可以自己填写，或让 AI 从对话中提取候选规则；AI 草稿须经你核对并确认。';
    $('task-summary-draft').placeholder = isAudit ? '核查对象与版本、指标、阈值或判定关系、抽样办法、通过与退回条件、参考标准……' : '处理范围、输入文件、具体清洗/转换规则、异常处理、验收标准、输出文件……只写已经确定的内容。';
    if (isDownload) $('task-summary-draft').placeholder = '下载来源、实际文件地址、年份与范围、版本、文件名和格式、完整性检查……';
    $('task-summary-ai').textContent = isAudit ? 'AI 提取候选原则' : 'AI 提取候选规则';
    $('task-summary-save').textContent = isAudit ? '确认核查原则' : '确认规则';
    $('task-rules-execute').hidden = isAudit;
    var rules = rulesFor(current());
    $('task-summary-draft').value = rules.draft || '';
    $('task-summary-confirmed').hidden = !rules.confirmed;
    $('task-summary-confirmed').textContent = rules.confirmed ? '当前生效的规则（v' + (rules.versions || []).length + '）\n' + rules.confirmed : '';
    $('task-summary-status').textContent = rules.confirmed ? '已确认 v' + (rules.versions || []).length : '尚未确认';
    if (isDownload) {
      $('task-summary').firstElementChild.textContent = '获取方案';
      $('task-summary-status').textContent = mod.doc && mod.doc.status === 'approved' ? '已审核 · 可执行' : mod.doc ? '待审核' : '待制定';
      $('task-rules-open').textContent = '查看方案';
    }
    if (isModify || isPlot) {
      var changed = !!rules.confirmed && rules.draft.trim() !== rules.confirmed;
      $('task-summary').firstElementChild.textContent = isPlot ? '绘图方案' : '计算修改方案';
      $('task-rules-open').textContent = isPlot ? '查看 / 编辑绘图方案' : '查看 / 编辑修改方案';
      $('rules-dialog').querySelector('h2').textContent = isPlot ? '绘图方案' : '计算修改方案';
      $('rules-dialog').querySelector('p').textContent = isPlot ? '先上传数据并在对话中讨论，再核对图型、字段与单位、分组、筛选与聚合、误差线、样式和输出格式。审核后点击生成；修改后重新审核，每次生成保留独立版本。' : '本模块只使用这一份修改方案。讨论后写明修改目标、输入、公式或参数、影响范围、验证办法和输出；人工审核通过后，再按此版本修改并运行代码。';
      $('task-summary-draft').placeholder = '修改目标、代码与输入文件、公式与参数变更、修改范围、异常处理、验证与通过条件、输出……';
      if (isPlot) $('task-summary-draft').placeholder = '数据文件与版本、图型、X/Y字段及单位、分组、筛选与聚合、缺失处理、误差线含义、尺寸/配色、PNG/SVG/PDF等输出格式……';
      $('rules-dialog').querySelector('label[for="task-summary-draft"]').textContent = isPlot ? '绘图方案草稿' : '修改方案草稿';
      $('task-summary-ai').textContent = 'AI 提取候选方案';
      $('task-summary-save').textContent = '审核通过方案';
      $('task-summary-status').textContent = changed ? '草稿已修改 · 待重新审核' : rules.confirmed ? '已审核 v' + rules.versions.length : '待制定 / 审核';
      $('task-summary-confirmed').textContent = rules.confirmed ? '已审核的' + (isPlot ? '绘图方案' : '修改方案') + '（v' + rules.versions.length + '）\n' + rules.confirmed : '';
    } else $('rules-dialog').querySelector('label[for="task-summary-draft"]').textContent = '规则草稿';
    previousPlan(mod, rules);
    var history = $('task-summary-history');
    history.replaceChildren();
    var initial = document.createElement('option');
    initial.value = '';
    initial.textContent = '历史版本';
    history.appendChild(initial);
    (rules.versions || []).forEach(function (version, number) {
      var option = document.createElement('option');
      option.value = String(number);
      option.textContent = 'v' + (number + 1) + ' · ' + new Date(version.at).toLocaleString('zh-CN');
      history.appendChild(option);
    });
    history.disabled = !(rules.versions || []).length;
    $('task-rules-execute').textContent = isDownload ? '按方案开始下载' : isPlot ? '按方案生成图表' : isModify ? '按方案修改并计算' : '按规则执行清洗';
    refreshControls();
  }

  function switchTask(targetId) {
    if (targetId === index.activeTaskId) return true;
    if (busy() || pendingRules || startingExecution) { showMessage('当前任务正在处理，请等完成后再切换任务。'); render(); return false; }
    var target = index.tasks.filter(function (task) { return task.id === targetId; })[0];
    var targetState = target && readState(targetId);
    if (!targetState) { showMessage('该任务的本地记录无法读取，未切换。'); render(); return false; }
    if (!discussionProjectEvent('discussion-project-before-switch', targetId)) { discussionProjectEvent('discussion-project-switch-cancelled', targetId); showMessage('讨论或输入草稿尚未保存，未切换项目。请先保存或下载讨论备份。'); render(); return false; }
    if (!saveState()) { discussionProjectEvent('discussion-project-switch-cancelled', targetId); showMessage('当前讨论的本地保存失败，未切换项目。请先下载讨论备份。'); render(); return false; }
    switching = true;
    var previousId = index.activeTaskId;
    // Store broadcasts synchronously. Scope every observer to the destination
    // project before it sees the destination's messages and draft.
    index.activeTaskId = targetId;
    var restored = false;
    try { restored = root.Store.restoreState(targetState); } catch (error) { restored = false; }
    if (restored) {
      saveIndex();
    } else index.activeTaskId = previousId;
    switching = false;
    if (restored) discussionProjectEvent('discussion-project-after-switch', targetId);
    else discussionProjectEvent('discussion-project-switch-cancelled', targetId);
    showMessage(restored ? '' : '任务记录格式有误，未切换。');
    render();
    if (root.CodexUI && typeof root.CodexUI.render === 'function') root.CodexUI.render();
    return restored;
  }

  function createTask(name, start) {
    if (busy() || pendingRules || startingExecution) { showMessage('当前任务正在处理，请等完成后再新建任务。'); return false; }
    name = String(name || '').trim();
    if (!name) return false;
    var task = { id: id(), name: name.slice(0, 80), createdAt: new Date().toISOString(), rulesByModule: {} };
    if (!discussionProjectEvent('discussion-project-before-switch', task.id)) { discussionProjectEvent('discussion-project-switch-cancelled', task.id); showMessage('讨论或输入草稿尚未保存，未新建项目。请先保存或下载讨论备份。'); return false; }
    if (!saveState()) { discussionProjectEvent('discussion-project-switch-cancelled', task.id); showMessage('当前讨论的本地保存失败，未新建项目。请先下载讨论备份。'); return false; }
    index.tasks.push(task);
    index.activeTaskId = task.id;
    switching = true;
    root.Store.resetAll();
    if (start === 'research') {
      // 【九步研究流程 · 2026-10-21】九步链（①文献调研 … ⑨校稿核验）整体建一次。
      // 与数据链互斥：新建任务时只走其中一条，别把两条链混在一个任务里。
      // 逐步解锁：先只建第①步，后面每过一个审核门再自动补出下一个。
      if (typeof root.Store.startFlow === 'function') root.Store.startFlow();
    } else {
      // 【数据链 · 2026-10-22】三条并列准备路径汇入「模型调整与计算」。
      root.Store.addModule(({clean:'数据清洗', literature:'文献挖掘', calculation:'模型调整与计算'})[start] || '下载数据');
    }
    saveIndex();
    var saved = saveState();
    switching = false;
    discussionProjectEvent('discussion-project-after-switch', task.id);
    showMessage(saved ? '' : '浏览器本地存储已满：当前任务暂时只能在本页使用，请导出重要结果。');
    render();
    if (root.CodexUI && typeof root.CodexUI.render === 'function') root.CodexUI.render();
    return true;
  }

  function confirmedRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (mod && mod.type === 'download-data' && mod.doc) return mod.doc.status === 'approved' ? mod.doc.content : '';
    if (!mod || !(mod.type === 'download-data' || mod.type === 'clean-data' || isModification(mod) || isPlotting(mod) || mod.type === 'result-audit')) return '';
    return rulesFor(current(), mod.id).confirmed || '';
  }
  function ruleVersion() { return rulesFor(current()).versions.length; }

  function prepareDiscussion(mod) {
    if (root.CodexUI && root.CodexUI.useCodex(mod)) root.CodexUI.prepareRuleDiscussion(mod.id);
  }
  function discussRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (!mod) return;
    if (busy() || pendingRules || startingExecution) { showMessage('当前任务正在处理，请稍后继续讨论。'); return; }
    if ($('composer-input').value.trim()) { showMessage('输入框中还有未发送的内容，请先发送或暂存。'); return; }
    try { prepareDiscussion(mod); }
    catch (error) { showMessage('无法开始讨论：' + error.message); return; }
    var rules = rulesFor(current(), mod.id);
    var prompt = '我们在本平台当前模块继续讨论并完善规则。请先读取当前已交接或上传的文件（具备读取能力时），结合现有对话核对已确认的目标和方法；不要只重复这段文字。主动找出影响下一步的关键缺口，每轮提出1–3个具体问题，说明选项及其对结果的影响；已有明确答案直接沿用，不反复提问。由你在本对话中补问，不让研究者去其他地方填写或自行猜测。区分已经决定的处理规则、候选建议和待确认问题；不要把“先讨论”“请明确”等阶段性指令当成最终执行规则。现在只讨论和读取材料，不运行清洗、计算或绘图，不改写输入文件、不生成执行成果；讨论补齐后再整理候选规则供我确认。'
      + '\n当前已确认规则（保留已确定的处理要求；若仍含待定问题则继续讨论）：\n' + (rules.confirmed || '暂无')
      + '\n当前草稿（不代表已确认）：\n' + (rules.draft || '暂无');
    if (mod.type === 'clean-data' && root.CleanVerificationRules) prompt += '\n'+root.CleanVerificationRules.guidance();
    $('conversation-mode').value = 'ai';
    $('conversation-mode').dispatchEvent(new Event('change'));
    if (!root.ModuleSpace.sendText(prompt)) { showMessage('无法发送讨论请求，请检查当前模块状态。'); refreshControls(); return; }
    $('rules-dialog').close();
  }

  function extractRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (!mod) { showMessage('请先创建或选择一个模块。'); return; }
    if ($('conversation-mode').value !== 'ai') { showMessage('请先把底部输入模式切到“AI 对话”。'); return; }
    if ($('composer-input').value.trim()) { showMessage('输入框里还有未发送的文字，请先发送或暂存。'); return; }
    if (busy() || pendingRules || startingExecution) { showMessage('当前 AI 正在回复，请稍后。'); return; }
    var history = (mod.messages || []).filter(function (message) { return message.role === 'user' || message.role === 'assistant'; });
    if (!history.length) { showMessage('这个模块还没有对话。你可以先手写规则，或讨论后再提取。'); return; }
    var excerpts = history.slice(-22).map(function (entry) {
      return '[' + (entry.role === 'user' ? '我' : 'AI') + '] ' + entry.text.slice(0, 180);
    }).join('\n');
    var prompt = '请只从以下对话提取我已经明确决定采用的可执行规则，形成“候选规则草稿”。不要写对话摘要、背景、AI 建议、未确认的推测、已生成文件清单或无关内容。按适用范围、输入、处理步骤、异常处理、验收条件、输出列出；没有明确决定的条目写“待确认”，不能自行补造。尤其不能把 AI 的建议当成我的确认。只输出规则草稿。\n对话摘录：\n' + excerpts.slice(-3200);
    if (isModification(mod)) prompt = '请只从以下对话提取研究者明确决定采用的计算修改方案，按修改目标、代码与输入、公式或参数变更、影响范围、异常处理、验证与通过条件、输出列出。未确认项写“待确认”，不把建议转为决定，不写背景摘要，不修改或运行代码。只输出待研究者审核的方案草稿。\n对话摘录：\n' + excerpts.slice(-3200);
    if (isPlotting(mod)) prompt = '请把对话中研究者确定采用的绘图要求整理为待审核绘图方案，包括数据文件与版本、图型、横纵轴字段与单位、分组、筛选和聚合、缺失处理、误差线含义、样式与尺寸、输出格式。修订时以用户指定的历史图版本和修改意见为准，保留未改变的已审核要求。未确认的科学口径标待确认，不用建议代替决定，不生成图片或执行代码。\n对话摘录：\n' + excerpts.slice(-3200);
    if (mod.type === 'result-audit') prompt = '请只提取我在对话中明确决定采用的核查原则，按核查对象与版本、指标、阈值或判定关系、抽样办法、通过与退回条件、参考标准列出。不能把 AI 的建议当成我的确认，未确认项标为待确认。不要总结背景或无关讨论，只输出候选原则草稿。\n对话摘录：\n' + excerpts.slice(-3200);
    if (mod.type === 'clean-data' && root.CleanVerificationRules) prompt += '\n'+root.CleanVerificationRules.guidance();
    prompt += '\n只整理规则，不运行或改写文件。不要把“暂不执行”“请先明确”等讨论指令抄成数据处理规则；关键口径尚未决定时，在草稿末尾单列待确认问题并建议回到本模块继续讨论，不代替研究者作决定。';
    try { prepareDiscussion(mod); }
    catch (error) { showMessage('无法提取规则：' + error.message); return; }
    pendingRules = { taskId: index.activeTaskId, moduleId: state.activeModuleId };
    showMessage('正在提取候选规则；AI 输出不会自动生效。');
    render();
    if (!root.ModuleSpace.sendText(prompt)) { pendingRules = null; showMessage('发送失败，请检查 AI 连接。'); render(); }
  }

  function openCleanVerificationDraft(moduleId, options) {
    var state = root.Store.getState(), mod = state.modules.filter(function(item){return item.id===moduleId;})[0];
    if (!mod || mod.type !== 'clean-data' || state.activeModuleId !== moduleId || busy() || pendingRules || startingExecution) return false;
    prepareDiscussion(mod);
    var rules = rulesFor(current(),moduleId);
    var original = rules.draft || rules.confirmed || (mod.doc && mod.doc.content) || '';
    var template = root.CleanVerificationRules && root.CleanVerificationRules.template;
    if (!template) throw new Error('核验规则入口尚未加载，请刷新页面。');
    var templateText=template(),titles=['清洗核验规则','原值与结果核对','人工核验标准'], additions=[];
    titles.forEach(function(title){
      if (new RegExp('(?:^|\\n)\\s*###\\s+'+title+'\\s*(?:\\n|$)').test(original)) return;
      var start=templateText.indexOf('### '+title),end=templateText.indexOf('\n### ',start+4);
      if(start>=0)additions.push(templateText.slice(start,end<0 ? undefined : end).trim());
    });
    var standardNames=(options && Array.isArray(options.standardNames) ? options.standardNames : []).filter(function(name){return typeof name==='string' && name && !/[\\/\r\n]/.test(name);});
    var missingNames=standardNames.filter(function(name){return original.indexOf(name)<0;});
    if(missingNames.length)additions.unshift('标准原件（供讨论，上传未表示采用；采用后请在人工核验项依据中写明原件名及页/节）：\n'+missingNames.map(function(name){return '- '+name;}).join('\n'));
    var next=original.replace(/\s*$/,'')+(additions.length ? (original.trim() ? '\n\n' : '')+additions.join('\n\n') : '');
    if (next.length>12000) throw new Error('清洗方案接近字数上限，请先精简后再补充核验。原已确认规则未改变。');
    // Draft is local to the existing rules editor. No confirmation, run or
    // document save occurs on opening; cancelling restores the editor text.
    if (!cleanVerificationStage || cleanVerificationStage.moduleId !== moduleId || cleanVerificationStage.taskId !== index.activeTaskId) cleanVerificationStage = {moduleId:moduleId,taskId:index.activeTaskId,previousDraft:rules.draft || '',previousComposer:$('composer-input').value,draftEdited:false};
    rules.draft=next;
    cleanVerificationStage.stagedDraft=next;
    render(); $('rules-dialog').showModal();
    showMessage('核验内容已放入同一份清洗方案草稿，尚未确认。可粘贴人工标准；提供的原件需整理成明确核验项并写入依据。原已确认版本保留，本入口不执行。');
    if (!$('composer-input').value.trim()) {
      $('composer-input').value='请结合本批输入和已有清洗方案，一起讨论清洗核验规则：重复判据、缺失与异常处理、单位与公式、允许误差，并把我粘贴或提供的人工标准整理成核验内容、检查方法、通过条件、必需与否、依据。能自动判断的由程序检查，需要专业判断的列人工项；依据保留完整标准文件名及页/节，无法读取的原件明确说明。先给精简推荐，由我确认后整理进同一份方案；不代替我签署人工通过。先不运行清洗。'+(standardNames.length ? '\n标准原件：\n'+standardNames.join('\n') : '');
      cleanVerificationStage.automaticComposer=$('composer-input').value;
      $('composer-input').dispatchEvent(new Event('input'));
    }
    return true;
  }
  function confirmRules() {
    var activeState = root.Store.getState();
    var activeModule = activeState.modules.filter(function (item) { return item.id === activeState.activeModuleId; })[0];
    var draft = $('task-summary-draft').value.trim();
    if (!draft) { showMessage('请先填写具体执行规则。'); return; }
    if (draft.length > 12000) { showMessage('规则过长，请精简到 12000 字以内。'); return; }
    var task = current();
    var rules = rulesFor(task);
    if (rules.confirmed === draft) { showMessage('规则内容没有变化，当前版本继续生效。'); return; }
    var previous = { draft: rules.draft, confirmed: rules.confirmed, versions: rules.versions.slice() };
    cleanVerificationStage = null;
    rules.draft = draft;
    rules.confirmed = draft;
    rules.versions.push({ at: new Date().toISOString(), text: draft });
    if (!saveIndex()) { task.rulesByModule[root.Store.getState().activeModuleId] = previous; showMessage('浏览器本地存储已满，规则未能可靠保存。'); return; }
    showMessage(isPlotting(activeModule) ? '绘图方案 v' + rules.versions.length + ' 已审核，可按此版本生成图表。' : isModification(activeModule) ? '计算修改方案 v' + rules.versions.length + ' 已审核；可按此版本修改并计算。' : '规则 v' + rules.versions.length + ' 已确认，将用于本模块后续任务。');
    render();
  }

  async function executeRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (mod && mod.type === 'clean-data' && root.CodexUI?.syncCleanRuleUpdate) {
      var initialTaskId = index.activeTaskId, initialModuleId = mod.id;
      try { await root.CodexUI.syncCleanRuleUpdate(mod.id); }
      catch (error) { showMessage('无法同步本次已授权规则：' + error.message + '；未启动清洗。'); refreshControls(); return; }
      state = root.Store.getState();
      mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
      if (index.activeTaskId !== initialTaskId || !mod || mod.id !== initialModuleId || mod.type !== 'clean-data') { showMessage('当前任务或模块已变化，未启动清洗。'); return; }
    }
    var rules = confirmedRules();
    if (!rules) { showMessage('请先确认执行规则。'); return; }
    if (hasEditableRules(mod) && rulesFor(current(), mod.id).draft.trim() !== rules) { showMessage('规则草稿已变化，请重新确认后再执行。'); refreshControls(); return; }
    if (startingExecution) { showMessage('正在准备执行，请等待，不必重复点击。'); return; }
    if (mod && mod.type === 'download-data') {
      if (busy() || pendingRules) { showMessage('当前任务尚未完成，请稍后。'); return; }
      if (root.CodexUI.openDownload(mod)) $('rules-dialog').close();
      return;
    }
    if (!mod || !(mod.type === 'clean-data' || isModification(mod) || isPlotting(mod))) { showMessage('当前模块不支持按方案执行文件处理。'); return; }
    if (busy() || pendingRules) { showMessage('当前 AI 正在处理，请稍后。'); return; }
    if (!root.CodexUI || !root.CodexUI.useCodex(mod)) { showMessage('请先将模块助手切换为“本机 Codex”。'); return; }
    var taskId = index.activeTaskId, version = ruleVersion();
    startingExecution = { taskId: taskId, moduleId: mod.id };
    refreshControls();
    showMessage('正在核对已上传的原始文件……');
    try {
      var ready = await root.CodexUI.prepareConfirmedExecution(mod.id);
      if (!ready) { root.CodexUI.cancelPreparedExecution(mod.id); showMessage(isPlotting(mod) ? '请先上传并选择绘图数据。' : mod.type === 'clean-data' ? '当前清洗模块没有输入文件，请先交接下载结果或上传原始数据。' : '请先在当前模块上传代码与输入数据，再执行。'); return; }
      if (index.activeTaskId !== taskId || root.Store.getState().activeModuleId !== mod.id || confirmedRules() !== rules || ruleVersion() !== version || rulesFor(current(),mod.id).draft.trim() !== rules) throw new Error('任务或规则已变化，请重新确认后执行。');
      $('conversation-mode').value = 'ai';
      $('conversation-mode').dispatchEvent(new Event('change'));
      var instruction = isPlotting(mod)
        ? '请按本模块已审核的绘图方案 v' + version + ' 生成图表，实际运行绘图代码并核对输出。保存PNG预览、方案要求的图片格式、可独立复现的绘图代码、绘图数据和运行说明。以本次冻结的输入和选定历史版本为准，另存新版本；科学口径缺失或冲突时停下说明。'
        : mod.type === 'calculation'
        ? '请依据本模块已审核的计算修改方案 v' + version + '，在输出目录中复制并修改已上传的计算代码，然后运行修改后的代码处理已上传的输入数据。不得覆盖原代码。交付修改后的代码、计算结果、运行日志和核查报告；方案未覆盖的科学判断先停下询问。'
        : '请执行本模块已确认的清洗规则 v' + version + '。只处理本模块上传的原始文件；规则未覆盖的科学判断先停下询问。生成清洗结果、可复现代码和检查报告，并在报告中注明规则版本。按冻结方案交付逐条去向、原始行到结果行对应及规则依据，后台独立核验原值与结果，合并拆分不能仅比较前后行数；未覆盖的科学判断列待处理，不自行填补或删除。';
      if (!root.ModuleSpace.sendText(instruction)) { root.CodexUI.cancelPreparedExecution(mod.id); showMessage('启动失败，请检查当前模块状态。'); render(); return; }
      $('rules-dialog').close();
    } catch (error) { root.CodexUI.cancelPreparedExecution(mod.id); showMessage('无法启动执行：' + error.message); }
    finally { startingExecution = null; refreshControls(); }
  }

  initialize();
  function snapshotModuleRules(moduleId) {
    var task = current();
    var rules = task && task.rulesByModule && task.rulesByModule[moduleId];
    return rules ? JSON.parse(JSON.stringify(rules)) : null;
  }
  function restoreModuleRules(moduleId, rules) {
    if (!moduleId || busy() || pendingRules || startingExecution) return false;
    var task = current();
    if (!task) return false;
    var previous = JSON.parse(JSON.stringify(task.rulesByModule || {}));
    task.rulesByModule = task.rulesByModule || {};
    if (rules === null || rules === undefined) delete task.rulesByModule[moduleId];
    else {
      if (typeof rules !== 'object' || Array.isArray(rules)) return false;
      task.rulesByModule[moduleId] = JSON.parse(JSON.stringify(rules));
    }
    if (saveIndex()) return true;
    task.rulesByModule = previous;
    memory[INDEX_KEY] = JSON.stringify(index);
    return false;
  }
  // Apply a session-bound correction explicitly authorised by the researcher.
  // This updates only the approved rules, retaining all earlier versions and
  // conversations. It never sends a prompt or starts file processing.
  function applyCleanRuleUpdate(moduleId, patch) {
    var state = root.Store.getState(), task = current();
    var mod = state.modules.filter(function (item) { return item.id === moduleId; })[0];
    var refused = function (reason) { return { applied: false, unchanged: false, reason: reason }; };
    if (!task || switching || !mod || mod.type !== 'clean-data' || state.activeModuleId !== moduleId) return refused('not-current-clean-module');
    if (busy() || pendingRules || startingExecution || cleanVerificationStage) return refused('busy-or-editing');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || typeof patch.id !== 'string' || !patch.id || patch.id.length > 160
      || typeof patch.sessionId !== 'string' || !patch.sessionId
      || root.CodexUI?.cleanSessionId?.(moduleId) !== patch.sessionId) return refused('session-mismatch');
    if (typeof patch.beforeText !== 'string' || !patch.beforeText || typeof patch.afterText !== 'string'
      || !patch.afterText.trim() || patch.afterText.length > 12000 || patch.beforeText === patch.afterText
      || !/^[a-f0-9]{64}$/i.test(patch.beforeSha256 || '') || !/^[a-f0-9]{64}$/i.test(patch.afterSha256 || '')
      || !patch.binding || typeof patch.binding !== 'object' || Array.isArray(patch.binding)
      || !patch.authorization || typeof patch.authorization !== 'string' && (typeof patch.authorization !== 'object' || Array.isArray(patch.authorization))) return refused('invalid-update');
    var resolved;
    try { resolved = root.CleanExecutionPlan?.resolve?.(patch.beforeText, patch.binding); }
    catch (_) { return refused('invalid-resolution'); }
    if (!resolved || resolved.text !== patch.afterText) return refused('invalid-resolution');
    var rules = task.rulesByModule && task.rulesByModule[moduleId];
    if (!rules || !Array.isArray(rules.versions)) return refused('missing-existing-rules');
    var previousUpdate = rules.versions.filter(function (version) { return version.ruleUpdateId === patch.id; })[0];
    if (previousUpdate) return previousUpdate.text === patch.afterText
      ? { applied: false, unchanged: true, version: rules.versions.indexOf(previousUpdate) + 1, reason: 'already-applied' }
      : refused('update-id-conflict');
    // The editor trims approved text while a frozen source may retain its final
    // newline or use CRLF. Ignore only those serialization differences; changes
    // inside the approved policy still require the researcher's review.
    var comparable = function (text) { return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : null; };
    if (comparable(rules.confirmed) !== comparable(patch.beforeText)) return refused('approved-rules-changed');
    if (typeof rules.draft !== 'string' || comparable(rules.draft) !== comparable(rules.confirmed)) return refused('draft-changed');
    var previous = JSON.parse(JSON.stringify(rules)), next = JSON.parse(JSON.stringify(rules));
    // Legacy state occasionally kept a confirmed text without a matching
    // history entry. Preserve it before appending the new authorised version.
    if (!next.versions.some(function (version) { return version.text === rules.confirmed; })) next.versions.push({
      at: new Date().toISOString(), text: rules.confirmed, recoveredPreviousConfirmed: true
    });
    next.versions.push({ at: patch.createdAt || new Date().toISOString(), text: patch.afterText,
      ruleUpdateId: patch.id, authorization: JSON.parse(JSON.stringify(patch.authorization)),
      previousSha256: patch.beforeSha256, sha256: patch.afterSha256,
      binding: JSON.parse(JSON.stringify(patch.binding)), source: 'authorised-clean-rule-update' });
    next.draft = patch.afterText;
    next.confirmed = patch.afterText;
    task.rulesByModule[moduleId] = next;
    if (!saveIndex()) {
      task.rulesByModule[moduleId] = previous;
      memory[INDEX_KEY] = JSON.stringify(index);
      return refused('storage-failed');
    }
    showMessage('已按你的授权同步 A 规则 v' + next.versions.length + '：输入版本绑定和异常处理已明确，旧规则与讨论保留。可直接点击“按规则执行清洗”。');
    render();
    return { applied: true, unchanged: false, version: next.versions.length, reason: 'applied' };
  }
  root.TaskManager = { confirmedRules: confirmedRules, switchTask: switchTask, createTask: createTask, refreshControls: refreshControls,
    currentTaskId: function () { return switching ? null : index.activeTaskId; }, snapshotModuleRules: snapshotModuleRules, restoreModuleRules: restoreModuleRules,
    openPlan: function () { $('rules-dialog').showModal(); render(); },
    openCleanVerificationDraft: openCleanVerificationDraft, applyCleanRuleUpdate: applyCleanRuleUpdate,
    rulesForModule: function (moduleId) { var rules = rulesFor(current(), moduleId); return { text: rules.confirmed || '', draft:rules.draft || '', dirty:!!rules.confirmed && (rules.draft || '').trim() !== rules.confirmed, version: (rules.versions || []).length }; } };
  $('task-select').addEventListener('change', function (event) { switchTask(event.target.value); });
  $('task-new').addEventListener('click', function () {
    if (busy() || pendingRules) { showMessage('当前 AI 正在回复，请等完成后再新建任务。'); return; }
    $('task-name').value = '';
    $('task-start').value = 'clean';
    $('task-dialog').showModal();
    $('task-name').focus();
  });
  $('task-dialog-close').addEventListener('click', function () { $('task-dialog').close(); });
  $('task-dialog-cancel').addEventListener('click', function () { $('task-dialog').close(); });
  $('task-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (createTask($('task-name').value, $('task-start').value)) {
      $('task-dialog').close();
      if ($('task-start').value === 'clean') $('rules-dialog').showModal();
    }
  });
  $('task-rules-open').addEventListener('click', function () {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (mod && mod.type === 'download-data') {
      var card = document.querySelector('#module-space .doc-card');
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    $('rules-dialog').showModal(); render();
  });
  function discardCleanVerificationStage() {
    var stage=cleanVerificationStage;
    cleanVerificationStage = null;
    if (!stage || stage.taskId !== index.activeTaskId) return;
    var rules=rulesFor(current(),stage.moduleId),restored=!stage.draftEdited && rules.draft===stage.stagedDraft;
    if(restored)rules.draft=stage.previousDraft;
    var composer=$('composer-input');
    if(typeof stage.automaticComposer==='string' && composer.value===stage.automaticComposer){composer.value=stage.previousComposer;composer.dispatchEvent(new Event('input'));}
    showMessage(restored ? '已取消本次未确认补充，原方案保留。' : '已关闭；自行编辑的草稿保留，尚未确认。');
    if(root.CodexUI && typeof root.CodexUI.render==='function')root.CodexUI.render();
  }
  $('rules-dialog-close').addEventListener('click', function () { discardCleanVerificationStage(); $('rules-dialog').close(); render(); });
  $('rules-dialog').addEventListener('cancel', function () { discardCleanVerificationStage(); render(); });
  $('task-summary-ai').addEventListener('click', extractRules);
  $('task-rules-discuss').addEventListener('click', discussRules);
  $('task-summary-save').addEventListener('click', confirmRules);
  $('task-rules-execute').addEventListener('click', executeRules);
  $('task-summary-draft').addEventListener('input', function () {
    if(cleanVerificationStage && cleanVerificationStage.taskId===index.activeTaskId && cleanVerificationStage.moduleId===root.Store.getState().activeModuleId)cleanVerificationStage.draftEdited=true;
    rulesFor(current()).draft = this.value;
    saveIndex();
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    refreshControls();
  });
  $('task-summary-history').addEventListener('change', function () {
    if (this.value === '') return;
    var version = (rulesFor(current()).versions || [])[Number(this.value)];
    if (!version) return;
    rulesFor(current()).draft = version.text;
    saveIndex();
    $('task-summary-draft').value = version.text;
    showMessage('已将历史版本放入草稿；修改后点击“确认规则”才会生效。');
    this.value = '';
    refreshControls();
  });
  root.Store.subscribe(function (event) {
    if (switching) return;
    saveState();
    if (pendingRules && pendingRules.taskId === index.activeTaskId && event.type === 'message:append' && event.payload.moduleId === pendingRules.moduleId) {
      if (event.payload.role === 'assistant') {
        rulesFor(current(), pendingRules.moduleId).draft = event.payload.message.text;
        saveIndex();
        pendingRules = null;
        var activeState = root.Store.getState();
        var activeModule = activeState.modules.filter(function (item) { return item.id === activeState.activeModuleId; })[0];
        showMessage(isPlotting(activeModule) ? '候选绘图方案已填入，请核对后点击“审核通过方案”。' : isModification(activeModule) ? '候选修改方案已填入，请核对后点击“审核通过方案”。' : '候选规则已填入。请删去不属于执行规则的内容，再点击“确认规则”。');
        render();
      } else if (event.payload.role === 'system') {
        pendingRules = null;
        showMessage('AI 提取失败，请检查连接后重试。');
        render();
      }
    }
    render();
  });
  render();
  if (bootstrapMessage) showMessage(bootstrapMessage);
})(typeof window !== 'undefined' ? window : this);
