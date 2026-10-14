/* 独立研究任务：隔离模块会话，并保存研究者确认的执行规则。 */
;(function (root) {
  'use strict';

  var INDEX_KEY = 'research_tasks_v1';
  var STATE_PREFIX = 'research_task_state_';
  var $ = function (id) { return document.getElementById(id); };
  var memory = {};
  var switching = false;
  var pendingRules = null;
  var index;

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
  function saveState() { return write(STATE_PREFIX + index.activeTaskId, JSON.stringify(root.Store.getState())); }
  function readState(taskId) {
    try { return JSON.parse(read(STATE_PREFIX + taskId)); } catch (e) { return null; }
  }
  function showMessage(value) { $('task-summary-message').textContent = value || ''; }
  function busy() { return !!(root.ModuleSpace && root.ModuleSpace.isBusy()); }
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

  function initialize() {
    try { index = JSON.parse(read(INDEX_KEY)); } catch (e) { index = null; }
    var fresh = !index || !Array.isArray(index.tasks) || !index.tasks.length || !index.tasks.some(function (task) { return task.id === index.activeTaskId; });
    if (fresh) {
      var first = { id: id(), name: '原有练习', createdAt: new Date().toISOString(), rulesByModule: {} };
      index = { activeTaskId: first.id, tasks: [first] };
      saveIndex();
    }
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
    var rulesVisible = !!mod && (mod.type === 'clean-data' || mod.type === 'calculation' && mod.mode === 'modify' || isAudit);
    $('task-summary').hidden = !rulesVisible;
    $('task-summary').firstElementChild.textContent = isAudit ? '核查原则' : '执行规则';
    $('task-rules-open').textContent = isAudit ? '查看 / 编辑核查原则' : '查看 / 编辑规则';
    $('rules-dialog').querySelector('h2').textContent = isAudit ? '核查原则' : '执行规则';
    $('rules-dialog').querySelector('p').textContent = isAudit ? '保存你确定采用的核查对象、指标、阈值和通过条件。可自行填写，或从讨论中提取候选原则；确认后作为核查依据。已有标准也可在模块中直接上传。' : '这里只放你决定要执行的规则。可以自己填写，或让 AI 从对话中提取候选规则；AI 草稿须经你核对并确认。';
    $('task-summary-draft').placeholder = isAudit ? '核查对象与版本、指标、阈值或判定关系、抽样办法、通过与退回条件、参考标准……' : '处理范围、输入文件、具体清洗/转换规则、异常处理、验收标准、输出文件……只写已经确定的内容。';
    $('task-summary-ai').textContent = isAudit ? 'AI 提取候选原则' : 'AI 提取候选规则';
    $('task-summary-save').textContent = isAudit ? '确认核查原则' : '确认规则';
    $('task-rules-execute').hidden = isAudit;
    var rules = rulesFor(current());
    $('task-summary-draft').value = rules.draft || '';
    $('task-summary-confirmed').hidden = !rules.confirmed;
    $('task-summary-confirmed').textContent = rules.confirmed ? '当前生效的规则（v' + (rules.versions || []).length + '）\n' + rules.confirmed : '';
    $('task-summary-status').textContent = rules.confirmed ? '已确认 v' + (rules.versions || []).length : '尚未确认';
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
    $('task-summary-ai').disabled = !!pendingRules || busy();
    $('task-rules-execute').textContent = mod && mod.type === 'calculation' ? '按规则修改并计算' : '按规则执行清洗';
    $('task-rules-execute').disabled = !rules.confirmed || !rulesVisible || !!pendingRules || busy();
  }

  function switchTask(targetId) {
    if (targetId === index.activeTaskId) return true;
    if (busy() || pendingRules) { showMessage('当前 AI 正在回复，请等完成后再切换任务。'); render(); return false; }
    var target = index.tasks.filter(function (task) { return task.id === targetId; })[0];
    var targetState = target && readState(targetId);
    if (!targetState) { showMessage('该任务的本地记录无法读取，未切换。'); render(); return false; }
    saveState();
    switching = true;
    var restored = root.Store.restoreState(targetState);
    if (restored) {
      index.activeTaskId = targetId;
      saveIndex();
    }
    switching = false;
    showMessage(restored ? '' : '任务记录格式有误，未切换。');
    render();
    return restored;
  }

  function createTask(name, start) {
    if (busy() || pendingRules) { showMessage('当前 AI 正在回复，请等完成后再新建任务。'); return false; }
    name = String(name || '').trim();
    if (!name) return false;
    saveState();
    var task = { id: id(), name: name.slice(0, 80), createdAt: new Date().toISOString(), rulesByModule: {} };
    switching = true;
    root.Store.resetAll();
    root.Store.addModule('下载数据');
    if (start === 'clean' || start === 'calculation') root.Store.addModule('数据清洗');
    if (start === 'calculation') root.Store.addModule('计算');
    index.tasks.push(task);
    index.activeTaskId = task.id;
    saveIndex();
    var saved = saveState();
    switching = false;
    showMessage(saved ? '' : '浏览器本地存储已满：当前任务暂时只能在本页使用，请导出重要结果。');
    render();
    return true;
  }

  function confirmedRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (!mod || !(mod.type === 'clean-data' || mod.type === 'calculation' && mod.mode === 'modify' || mod.type === 'result-audit')) return '';
    return rulesFor(current(), mod.id).confirmed || '';
  }
  function ruleVersion() { return rulesFor(current()).versions.length; }

  function extractRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    if (!mod) { showMessage('请先创建或选择一个模块。'); return; }
    if ($('conversation-mode').value !== 'ai') { showMessage('请先把底部输入模式切到“AI 对话”。'); return; }
    if ($('composer-input').value.trim()) { showMessage('输入框里还有未发送的文字，请先发送或暂存。'); return; }
    if (busy() || pendingRules) { showMessage('当前 AI 正在回复，请稍后。'); return; }
    var history = (mod.messages || []).filter(function (message) { return message.role === 'user' || message.role === 'assistant'; });
    if (!history.length) { showMessage('这个模块还没有对话。你可以先手写规则，或讨论后再提取。'); return; }
    var excerpts = history.slice(-22).map(function (entry) {
      return '[' + (entry.role === 'user' ? '我' : 'AI') + '] ' + entry.text.slice(0, 180);
    }).join('\n');
    var prompt = '请只从以下对话提取我已经明确决定采用的可执行规则，形成“候选规则草稿”。不要写对话摘要、背景、AI 建议、未确认的推测、已生成文件清单或无关内容。按适用范围、输入、处理步骤、异常处理、验收条件、输出列出；没有明确决定的条目写“待确认”，不能自行补造。尤其不能把 AI 的建议当成我的确认。只输出规则草稿。\n对话摘录：\n' + excerpts.slice(-3200);
    if (mod.type === 'result-audit') prompt = '请只提取我在对话中明确决定采用的核查原则，按核查对象与版本、指标、阈值或判定关系、抽样办法、通过与退回条件、参考标准列出。不能把 AI 的建议当成我的确认，未确认项标为待确认。不要总结背景或无关讨论，只输出候选原则草稿。\n对话摘录：\n' + excerpts.slice(-3200);
    pendingRules = { taskId: index.activeTaskId, moduleId: state.activeModuleId };
    showMessage('正在提取候选规则；AI 输出不会自动生效。');
    render();
    if (!root.ModuleSpace.sendText(prompt)) { pendingRules = null; showMessage('发送失败，请检查 AI 连接。'); render(); }
  }

  function confirmRules() {
    var draft = $('task-summary-draft').value.trim();
    if (!draft) { showMessage('请先填写具体执行规则。'); return; }
    if (draft.length > 12000) { showMessage('规则过长，请精简到 12000 字以内。'); return; }
    var task = current();
    var rules = rulesFor(task);
    if (rules.confirmed === draft) { showMessage('规则内容没有变化，当前版本继续生效。'); return; }
    var previous = { draft: rules.draft, confirmed: rules.confirmed, versions: rules.versions.slice() };
    rules.draft = draft;
    rules.confirmed = draft;
    rules.versions.push({ at: new Date().toISOString(), text: draft });
    if (!saveIndex()) { task.rulesByModule[root.Store.getState().activeModuleId] = previous; showMessage('浏览器本地存储已满，规则未能可靠保存。'); return; }
    showMessage('规则 v' + rules.versions.length + ' 已确认，将用于本模块后续任务。');
    render();
  }

  async function executeRules() {
    var state = root.Store.getState();
    var mod = state.modules.filter(function (item) { return item.id === state.activeModuleId; })[0];
    var rules = confirmedRules();
    if (!rules) { showMessage('请先确认执行规则。'); return; }
    if (!mod || !(mod.type === 'clean-data' || mod.type === 'calculation' && mod.mode === 'modify')) { showMessage('当前模块不支持按规则执行文件处理。'); return; }
    if (busy() || pendingRules) { showMessage('当前 AI 正在处理，请稍后。'); return; }
    if (!root.CodexUI || !root.CodexUI.useCodex(mod)) { showMessage('请先将模块助手切换为“本机 Codex”。'); return; }
    $('task-rules-execute').disabled = true;
    showMessage('正在核对已上传的原始文件……');
    try {
      var ready = await root.CodexUI.prepareConfirmedExecution(mod.id);
      if (!ready) { showMessage('请先在当前模块上传代码与输入数据，再按规则执行。'); render(); return; }
      $('conversation-mode').value = 'ai';
      $('conversation-mode').dispatchEvent(new Event('change'));
      var instruction = mod.type === 'calculation'
        ? '请依据本模块已确认的修改规则 v' + ruleVersion() + '，在输出目录中复制并修改已上传的计算代码，然后运行修改后的代码处理已上传的输入数据。不得覆盖原代码。交付修改后的代码、计算结果、运行日志和核查报告；规则未覆盖的科学判断先停下询问。'
        : '请执行本模块已确认的清洗规则 v' + ruleVersion() + '。只处理本模块上传的原始文件；规则未覆盖的科学判断先停下询问。生成清洗结果、可复现代码和检查报告，并在报告中注明规则版本。';
      if (!root.ModuleSpace.sendText(instruction)) { root.CodexUI.cancelPreparedExecution(mod.id); showMessage('启动失败，请检查当前模块状态。'); render(); return; }
      $('rules-dialog').close();
    } catch (error) { root.CodexUI.cancelPreparedExecution(mod.id); showMessage('无法启动执行：' + error.message); }
    render();
  }

  initialize();
  root.TaskManager = { confirmedRules: confirmedRules, switchTask: switchTask, createTask: createTask };
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
  $('task-rules-open').addEventListener('click', function () { $('rules-dialog').showModal(); render(); });
  $('rules-dialog-close').addEventListener('click', function () { $('rules-dialog').close(); });
  $('task-summary-ai').addEventListener('click', extractRules);
  $('task-summary-save').addEventListener('click', confirmRules);
  $('task-rules-execute').addEventListener('click', executeRules);
  $('task-summary-draft').addEventListener('input', function () {
    rulesFor(current()).draft = this.value;
    saveIndex();
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
  });
  root.Store.subscribe(function (event) {
    if (switching) return;
    saveState();
    if (pendingRules && pendingRules.taskId === index.activeTaskId && event.type === 'message:append' && event.payload.moduleId === pendingRules.moduleId) {
      if (event.payload.role === 'assistant') {
        rulesFor(current(), pendingRules.moduleId).draft = event.payload.message.text;
        saveIndex();
        pendingRules = null;
        showMessage('候选规则已填入。请删去不属于执行规则的内容，再点击“确认规则”。');
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
})(typeof window !== 'undefined' ? window : this);
