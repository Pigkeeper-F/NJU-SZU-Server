/*!
 * 流程智能体 —— 数据层 window.Store
 * 纯浏览器 script（无 module / 无框架 / 无第三方依赖），file:// 双击 index.html 即可运行。
 *
 * ============================ 数据结构 ============================
 * state = {
 *   sidebar: { collapsed: false, width: 240 },   // collapsed 布尔；width 数字，夹取 180~520
 *   tabs:    [ { id:"flow", name:"流程" } ],      // 左侧栏选项卡（当前仅 flow，逻辑通用）
 *   activeTabId: "flow",
 *   modules: [ module ],                          // 模块链，靠后的模块依赖紧邻的前一个（强依赖 A→B→C）
 *   activeModuleId: null                          // 当前模块 id 或 null
 * }
 * module = {
 *   id: "mod_xxx",           // 唯一字符串 id
 *   name: "模块1",
 *   dependsOn: null,         // 上游模块 id；链尾新增时 = 前一个模块 id；首模块为 null
 *   createdAt: "ISO 字符串",
 *   messages: [ message ],
 *   doc: null,               // 环节文档；无文档时为 null（见下方 doc 结构）
 *   run: null                // 执行记录；未执行为 null（见下方 run 结构）
 * }
 * message = { id:"msg_xxx", role:"user"|"assistant"|"system", text:"非空字符串", at:"ISO 字符串" }
 * doc = {                    // 环节文档（用户与 AI 协商的标准文档，可人工审核，见契约 §16）
 *   content: "非空字符串",    // 已 trim；长度 ≤ MAX_DOC_CHARS
 *   status: "draft"|"approved",
 *   updatedAt: "ISO 字符串",
 *   approvedAt: "ISO 字符串"|null
 * }
 * run = {                    // 执行记录（结果确认门，见契约 §18）
 *   status: "ran"|"confirmed",        // ran=已运行待确认；confirmed=人工已确认
 *   at: "ISO 字符串",                 // 本次运行时间
 *   dir: "工作目录字符串",            // 执行产物所在目录（可为空串）
 *   artifacts: [ { name:"文件名", size:数字 } ] // 产物清单
 * }
 *
 * ============================== API ==============================
 * 以下方法全部同步：
 *   getState()                             -> state 的深拷贝（只读快照；不要修改它，改状态请用下面的方法）
 *   subscribe(fn)                          -> unsubscribe()；fn 在每次变更时收到 { type, payload }
 *   addModule(name?)                       -> module 深拷贝（追加到链尾，dependsOn=前一个模块 id）
 *   selectModule(id)                       -> boolean
 *   removeModule(id)                       -> { ok:true } | { ok:false, reason:"..." }
 *   renameModule(id, name)                 -> boolean
 *   appendMessage(moduleId, text, role)    -> message 深拷贝 | null
 *   saveDoc(moduleId, content)             -> doc 深拷贝 | null（content 空/超长 → null；已存在则改稿回 draft）
 *   approveDoc(moduleId)                   -> boolean（无 doc → false；置 approved + approvedAt）
 *   rejectDoc(moduleId, note)              -> boolean（无 doc → false；置回 draft，note 非空时追加系统消息）
 *   markRun(moduleId, info)                -> run 深拷贝 | null（无模块 → null；info={dir?,artifacts?}；置 ran）
 *   confirmRun(moduleId)                   -> boolean（无 run 或 status!=='ran' → false；置 confirmed）
 *   rejectRun(moduleId, cause, note)       -> boolean（cause 非 data|code|doc 或无 run → false；run 清空 + 系统消息）
 *   setSidebar({collapsed,width})          -> sidebar 深拷贝（width 夹取 180~520）
 *   selectTab(id)                          -> boolean
 *   resetAll()                             -> 重置为默认 state 深拷贝
 *
 * 变更事件 type 约定：
 *   module:add / module:select / module:remove / module:rename / message:append / sidebar:change / tab:select / state:reset
 *   / doc:save / doc:approve / doc:reject
 *   / run:mark / run:confirm / run:reject
 *
 * 持久化：localStorage 键 "fa_state_v1"；解析失败或结构非法 -> 回默认值且不抛异常；
 *         localStorage 不可用（隐私模式/配额满）时静默降级为纯内存，不影响内存状态。
 * 约定：任何状态变更 -> 先落盘 -> 再同步 emit；订阅回调抛错被捕获，不影响其它订阅者。
 */
;(function (root) {
  'use strict';

  var STORAGE_KEY = 'fa_state_v1';
  var SIDEBAR_MIN = 180;
  var SIDEBAR_MAX = 520;
  var SIDEBAR_DEFAULT = 240;
  // 【安全修复 · 2026-10-13】单条记录上限。原来不限长，超长输入（MB 级）会撑爆 localStorage
  // 配额，persist() 静默失败降级为纯内存，刷新即丢且用户无感知。2 万字远超日常单条记录，
  // 又远离配额红线；超长时 appendMessage 返回 null，由 UI 层给出明确提示。
  var MAX_MESSAGE_CHARS = 20000;
  // 【能力节点 · 2026-10-14】环节文档上限。与单条消息同量级（2 万字），超长返回 null 由 UI 提示，
  // 避免超长文档撑爆 localStorage 配额（配额满会静默降级为纯内存，刷新即丢）。
  var MAX_DOC_CHARS = 20000;
  var TABS_DEFAULT = [{ id: 'flow', name: '流程' }];
  var ROLES = ['user', 'assistant', 'system'];
  // 必须与其他常量一起放在顶部：normalizeModule() 在**文件开头加载 localStorage** 时就会用到它
  // （若把它声明在文件后段，var 提升会让加载期的值为 undefined → 归一化抛错 → 状态回退成空）。
  var MODULE_STATUSES = ['todo', 'doing', 'review', 'approved'];
  var DOC_STATUSES = ['draft', 'approved'];
  // 【能力节点 · 2026-10-14】执行记录状态（见契约 §18）：ran=已运行待人工确认；confirmed=已确认。
  var RUN_STATUSES = ['ran', 'confirmed'];
  // 结果复核打回的三级归因：数据 / 代码 / 标准（doc）。归因决定问题回溯到哪一环。
  var RUN_CAUSES = ['data', 'code', 'doc'];
  var RUN_CAUSE_LABELS = { data: '数据', code: '代码', doc: '标准' };

  // ---------------------------------------------------------------- 工具

  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function deepClone(value) {
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(deepClone(value[i]));
      return arr;
    }
    if (value && typeof value === 'object') {
      var obj = {};
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) obj[k] = deepClone(value[k]);
      }
      return obj;
    }
    return value;
  }

  /** 返回夹取后的整数宽度；无法转成有限数字时返回 null（表示忽略本次输入） */
  function clampWidth(value) {
    var n = Number(value);
    if (typeof value === 'undefined' || value === null || value === '' || !isFinite(n)) return null;
    n = Math.round(n);
    if (n < SIDEBAR_MIN) n = SIDEBAR_MIN;
    if (n > SIDEBAR_MAX) n = SIDEBAR_MAX;
    return n;
  }

  function defaultState() {
    return {
      sidebar: { collapsed: false, width: SIDEBAR_DEFAULT },
      tabs: deepClone(TABS_DEFAULT),
      activeTabId: TABS_DEFAULT[0].id,
      modules: [],
      activeModuleId: null
    };
  }

  // ---------------------------------------------------------- 结构校验

  /** 校验并修复单个模块；seen 为“此前已接受模块 id 的集合”，用于保证依赖只能指向上游（天然无环） */
  function normalizeModule(raw, seen) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = (typeof raw.id === 'string') ? raw.id : '';
    if (!id || seen[id]) return null;
    var name = (typeof raw.name === 'string' && raw.name) ? raw.name : '模块';
    var dependsOn = (typeof raw.dependsOn === 'string' && seen[raw.dependsOn]) ? raw.dependsOn : null;
    var createdAt = (typeof raw.createdAt === 'string' && raw.createdAt) ? raw.createdAt : nowISO();
    var messages = [];
    if (Array.isArray(raw.messages)) {
      for (var i = 0; i < raw.messages.length; i++) {
        var m = raw.messages[i];
        if (!m || typeof m !== 'object' || typeof m.text !== 'string') continue;
        messages.push({
          id: (typeof m.id === 'string' && m.id) ? m.id : uid('msg_'),
          role: ROLES.indexOf(m.role) >= 0 ? m.role : 'user',
          text: m.text,
          at: (typeof m.at === 'string' && m.at) ? m.at : nowISO()
        });
      }
    }
    // 流程字段（v4 新增）：step / spec / status / approvedAt 必须在归一化时保留，
    // 否则刷新页面后流程说明与审核状态会被丢掉。
    var step = (typeof raw.step === 'string' && raw.step) ? raw.step : null;
    var approvedAt = (typeof raw.approvedAt === 'string' && raw.approvedAt) ? raw.approvedAt : null;
    var spec = null;
    if (raw.spec && typeof raw.spec === 'object' && !Array.isArray(raw.spec)) {
      var todo = [];
      if (Array.isArray(raw.spec.todo)) {
        for (var t = 0; t < raw.spec.todo.length; t++) {
          if (typeof raw.spec.todo[t] === 'string') todo.push(raw.spec.todo[t]);
        }
      }
      spec = {
        goal: (typeof raw.spec.goal === 'string') ? raw.spec.goal : '',
        todo: todo,
        output: (typeof raw.spec.output === 'string') ? raw.spec.output : '',
        acceptance: (typeof raw.spec.acceptance === 'string') ? raw.spec.acceptance : ''
      };
    }
    // 环节文档（v7 新增）：必须在归一化时保留，否则刷新页面后与 AI 协商好的文档会丢。
    // 空/非法文档一律降级为 null（与 saveDoc 的入参校验同一套规则，保证落盘-读取幂等）。
    var doc = null;
    if (raw.doc && typeof raw.doc === 'object' && !Array.isArray(raw.doc)) {
      var docContent = (typeof raw.doc.content === 'string') ? raw.doc.content : '';
      if (docContent && docContent.trim() && docContent.length <= MAX_DOC_CHARS) {
        var docOk = (raw.doc.status === 'approved');
        doc = {
          content: docContent,
          status: docOk ? 'approved' : 'draft',
          updatedAt: (typeof raw.doc.updatedAt === 'string' && raw.doc.updatedAt) ? raw.doc.updatedAt : nowISO(),
          // approvedAt 只在 approved 时保留，draft 强制为 null（避免 draft 残留过期通过时间）
          approvedAt: (docOk && typeof raw.doc.approvedAt === 'string' && raw.doc.approvedAt) ? raw.doc.approvedAt : null
        };
      }
    }

    // 执行记录（v8 新增）：必须在归一化时保留，否则刷新页面后"已运行/已确认"状态会丢。
    // 脏数据（缺 status / status 非法）一律降级为 null；artifacts 仅保留合法的 {name,size} 项。
    var run = null;
    if (raw.run && typeof raw.run === 'object' && !Array.isArray(raw.run) &&
        RUN_STATUSES.indexOf(raw.run.status) >= 0) {
      var artifacts = [];
      if (Array.isArray(raw.run.artifacts)) {
        for (var r = 0; r < raw.run.artifacts.length; r++) {
          var art = raw.run.artifacts[r];
          if (!art || typeof art !== 'object' || typeof art.name !== 'string' || !art.name) continue;
          artifacts.push({
            name: art.name,
            size: (typeof art.size === 'number' && isFinite(art.size)) ? art.size : 0
          });
        }
      }
      run = {
        status: raw.run.status,
        at: (typeof raw.run.at === 'string' && raw.run.at) ? raw.run.at : nowISO(),
        dir: (typeof raw.run.dir === 'string') ? raw.run.dir : '',
        artifacts: artifacts
      };
    }

    var out = {
      id: id, name: name, dependsOn: dependsOn, createdAt: createdAt,
      messages: messages, status: normalizeStatus(raw.status), doc: doc, run: run
    };
    if (step) out.step = step;
    if (spec) out.spec = spec;
    if (approvedAt) out.approvedAt = approvedAt;
    return out;
  }

  /** 把任意 JS 值规整成合法 state；非法输入返回 null（调用方回默认值） */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var st = defaultState();

    var sb = raw.sidebar;
    if (sb && typeof sb === 'object' && !Array.isArray(sb)) {
      if (typeof sb.collapsed === 'boolean') st.sidebar.collapsed = sb.collapsed;
      var w = clampWidth(sb.width);
      if (w !== null) st.sidebar.width = w;
    }

    if (Array.isArray(raw.tabs) && raw.tabs.length) {
      var tabs = [];
      for (var i = 0; i < raw.tabs.length; i++) {
        var t = raw.tabs[i];
        if (!t || typeof t !== 'object') continue;
        if (typeof t.id !== 'string' || !t.id) continue;
        if (typeof t.name !== 'string' || !t.name) continue;
        tabs.push({ id: t.id, name: t.name });
      }
      if (tabs.length) st.tabs = tabs;
    }

    var modules = [];
    var seen = {};
    if (Array.isArray(raw.modules)) {
      for (var j = 0; j < raw.modules.length; j++) {
        var mod = normalizeModule(raw.modules[j], seen);
        if (mod) {
          modules.push(mod);
          seen[mod.id] = true;
        }
      }
    }
    st.modules = modules;

    st.activeTabId = pickTabId(st, raw.activeTabId);
    st.activeModuleId = pickModuleId(st, raw.activeModuleId);
    return st;
  }

  function pickTabId(st, candidate) {
    for (var i = 0; i < st.tabs.length; i++) {
      if (st.tabs[i].id === candidate) return candidate;
    }
    return st.tabs.length ? st.tabs[0].id : null;
  }

  function pickModuleId(st, candidate) {
    for (var i = 0; i < st.modules.length; i++) {
      if (st.modules[i].id === candidate) return candidate;
    }
    return st.modules.length ? st.modules[st.modules.length - 1].id : null;
  }

  // -------------------------------------------------------- 读写与广播

  function readStorage() {
    try {
      if (!root.localStorage || typeof root.localStorage.getItem !== 'function') return null;
      var raw = root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return sanitize(JSON.parse(raw));
    } catch (e) {
      return null; // 解析失败 / 结构非法 / 读取被拒 -> 回默认值，绝不抛异常
    }
  }

  function persist() {
    try {
      if (!root.localStorage || typeof root.localStorage.setItem !== 'function') return;
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式 / 配额不足：静默降级为纯内存，内存状态仍然有效 */
    }
  }

  var state = readStorage() || defaultState();
  var listeners = [];

  function emit(type, payload) {
    persist();
    var snapshot = { type: type, payload: payload };
    var list = listeners.slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](snapshot);
      } catch (e) {
        if (root.console && root.console.error) root.console.error('[Store] 订阅回调异常（已忽略）:', e);
      }
    }
  }

  function indexOfModule(id) {
    for (var i = 0; i < state.modules.length; i++) {
      if (state.modules[i].id === id) return i;
    }
    return -1;
  }

  function findModule(id) {
    var idx = indexOfModule(id);
    return idx < 0 ? null : state.modules[idx];
  }

  // -------------------------------------------------------------- API

  /**
   * 返回 state 的深拷贝（只读快照）。
   * 选“深拷贝”而非只读引用：调用方随手改返回值不会污染内部状态；state 体积很小，复制开销可忽略。
   * 渲染时读一次即可（不要把 getState() 写进循环体）。
   */
  function getState() {
    return deepClone(state);
  }

  /** 注册变更监听；返回 unsubscribe()。注册时不会立即回调，只在变更时回调 ({ type, payload }) */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    var active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      for (var i = 0; i < listeners.length; i++) {
        if (listeners[i] === fn) {
          listeners.splice(i, 1);
          break;
        }
      }
    };
  }

  /* ------------------------------------------------------------------
   * 项目管理（本地多项目）
   *   当前项目 = state.modules（键 fa_state_v1）+ 项目名（键 research_workspace_meta_v1，
   *   由 workspace.js 读写；这里只读写其中的 name 字段）。
   *   归档项目 = 键 fa_projects_v1：[{ id, name, savedAt, modules, activeModuleId }]
   *   新建项目会把当前工作区（模块+消息）归档后再清空，因此不会丢数据；
   *   历史项目可随时打开（打开前同样会先归档当前工作区）。
   * ------------------------------------------------------------------ */
  var PROJECTS_KEY = 'fa_projects_v1';
  var PROJECT_META_KEY = 'research_workspace_meta_v1';
  // 【本地修复 · 2026-09-24】当前项目的稳定 id。
  // 原来「当前项目」只在 fa_state_v1 里，没有 id，因此无法在项目列表里标识自己；
  // 于是「列表 = 非当前项目」，打开一个项目就从列表里移除它 —— 空项目（没有模块）
  // 被打开时旧项目又不会被归档，用户看到的现象是「点过往的项目，那个项目就消失了」。
  // 现在给当前项目一个固定 id，列表改为保存**全部**项目（含当前），条目永不移除。
  var CURRENT_ID_KEY = 'fa_current_project_id_v1';
  var PROJECT_NAME_DEFAULT = '我的研究项目';

  function readJSON(key, fallback) {
    try {
      if (!root.localStorage || typeof root.localStorage.getItem !== 'function') return fallback;
      var raw = root.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      if (!root.localStorage || typeof root.localStorage.setItem !== 'function') return false;
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 当前项目名（取自 workspace.js 的 meta 键；缺失时用默认名） */
  function currentProjectName() {
    var meta = readJSON(PROJECT_META_KEY, null);
    if (meta && typeof meta === 'object' && typeof meta.name === 'string' && meta.name.trim()) {
      return meta.name.trim();
    }
    return PROJECT_NAME_DEFAULT;
  }

  /** 只更新 meta 里的 name，保留 note */
  function setProjectName(name) {
    var meta = readJSON(PROJECT_META_KEY, null);
    var note = (meta && typeof meta.note === 'string') ? meta.note : '';
    return writeJSON(PROJECT_META_KEY, { name: name, note: note });
  }

  /** 当前项目的 id：没有就生成一个并持久化（首次使用即完成迁移）。
   *  【安全修复 · 2026-10-13】首次生成时同步把当前项目写进列表——原来列表为空，
   *  listProjects() 返回 0 条、历史区整体隐藏，用户看不到当前项目条目也无法右键管理。 */
  function currentProjectId() {
    var id = readJSON(CURRENT_ID_KEY, null);
    if (typeof id === 'string' && id) return id;
    id = uid('prj_');
    writeJSON(CURRENT_ID_KEY, id);
    var list = readJSON(PROJECTS_KEY, []);
    if (Array.isArray(list)) {
      var exists = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) { exists = true; break; }
      }
      if (!exists) {
        list.push({
          id: id,
          name: currentProjectName(),
          savedAt: nowISO(),
          modules: deepClone(state.modules),
          activeModuleId: state.activeModuleId
        });
        writeJSON(PROJECTS_KEY, list);
      }
    }
    return id;
  }

  /** 项目列表（轻量视图，不含模块内容）。包含当前项目，用 isCurrent 标识 */
  function listProjects() {
    var id = currentProjectId();
    var list = readJSON(PROJECTS_KEY, []);
    if (!Array.isArray(list)) list = [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || typeof p.id !== 'string') continue;
      var isCurrent = (p.id === id);
      out.push({
        id: p.id,
        // 当前项目的名字以 meta 键为准（用户改名后立刻生效）
        name: isCurrent
          ? currentProjectName()
          : ((typeof p.name === 'string' && p.name) ? p.name : PROJECT_NAME_DEFAULT),
        savedAt: (typeof p.savedAt === 'string') ? p.savedAt : '',
        // 当前项目的模块数取内存里的实时值，避免列表条目滞后
        moduleCount: isCurrent
          ? state.modules.length
          : (Array.isArray(p.modules) ? p.modules.length : 0),
        isCurrent: isCurrent
      });
    }
    return out;
  }

  /**
   * 把当前工作区（名称 + 模块 + 选中项）写回它在项目列表里的那一条。
   * 条目已存在则**原地更新**，不存在则补一条 —— 不再 push 新条目、也不再移除任何条目。
   * -> { id, name } | null（写失败返回 null）
   */
  function saveCurrentProject() {
    var id = currentProjectId();
    var list = readJSON(PROJECTS_KEY, []);
    if (!Array.isArray(list)) list = [];
    var name = currentProjectName();
    var modules = deepClone(state.modules);
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { target = list[i]; break; }
    }
    if (target) {
      target.name = name;
      target.savedAt = nowISO();
      target.modules = modules;
      target.activeModuleId = state.activeModuleId;
    } else {
      list.push({
        id: id,
        name: name,
        savedAt: nowISO(),
        modules: modules,
        activeModuleId: state.activeModuleId
      });
    }
    if (!writeJSON(PROJECTS_KEY, list)) return null;
    return { id: id, name: name };
  }

  /** 新建项目：当前项目存回列表 → 追加一个空项目 → 切到新项目。列表条目只增不减 */
  function createProject(name) {
    var nm = (typeof name === 'string') ? name.trim() : '';
    if (!nm) return { ok: false, reason: '项目名不能为空' };
    var saved = saveCurrentProject();
    var id = uid('prj_');
    var list = readJSON(PROJECTS_KEY, []);
    if (!Array.isArray(list)) list = [];
    list.push({ id: id, name: nm, savedAt: nowISO(), modules: [], activeModuleId: null });
    if (!writeJSON(PROJECTS_KEY, list)) {
      return { ok: false, reason: '本地存储写入失败，未创建项目' };
    }
    writeJSON(CURRENT_ID_KEY, id);
    state.modules = [];
    state.activeModuleId = null;
    setProjectName(nm);
    emit('project:create', { name: nm, id: id, archived: saved });
    return { ok: true, name: nm, id: id, archived: saved };
  }

  /**
   * 删除项目。
   * 【本地修复 · 2026-09-24】删的是当前项目时：自动切到列表里剩下的第一个；
   * 一个都不剩就新建一个空的默认项目（保证工作区始终有效，不出现"没有项目"的僵尸态）。
   * -> { ok, deleted, switchedTo?, created? } | { ok:false, reason }
   */
  function deleteProject(id) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: '项目不存在' };
    var list = readJSON(PROJECTS_KEY, []);
    if (!Array.isArray(list)) return { ok: false, reason: '项目不存在' };
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) { idx = i; break; }
    if (idx < 0) return { ok: false, reason: '项目不存在' };
    var removed = list[idx];
    list.splice(idx, 1);
    if (!writeJSON(PROJECTS_KEY, list)) return { ok: false, reason: '本地存储写入失败' };

    if (id !== currentProjectId()) {
      emit('project:delete', { id: id, name: removed.name });
      return { ok: true, deleted: removed.name };
    }

    if (list.length) {
      var next = list[0];
      var seen = {};
      var modules = [];
      var incoming = Array.isArray(next.modules) ? next.modules : [];
      for (var k = 0; k < incoming.length; k++) {
        var mod = normalizeModule(incoming[k], seen);
        if (mod) { modules.push(mod); seen[mod.id] = true; }
      }
      writeJSON(CURRENT_ID_KEY, next.id);
      state.modules = modules;
      state.activeModuleId = modules.length ? pickModuleId({ modules: modules }, next.activeModuleId) : null;
      setProjectName((typeof next.name === 'string' && next.name) ? next.name : PROJECT_NAME_DEFAULT);
      emit('project:delete', { id: id, name: removed.name, switchedTo: next.id });
      return { ok: true, deleted: removed.name, switchedTo: next.name };
    }

    var fresh = uid('prj_');
    writeJSON(PROJECTS_KEY, [{ id: fresh, name: PROJECT_NAME_DEFAULT, savedAt: nowISO(), modules: [], activeModuleId: null }]);
    writeJSON(CURRENT_ID_KEY, fresh);
    state.modules = [];
    state.activeModuleId = null;
    setProjectName(PROJECT_NAME_DEFAULT);
    emit('project:delete', { id: id, name: removed.name, switchedTo: fresh });
    return { ok: true, deleted: removed.name, created: PROJECT_NAME_DEFAULT };
  }

  /**
   * 打开项目：当前项目存回列表 → 载入所选项目。
   * 【本地修复 · 2026-09-24】列表条目**一律保留**（原来会把被打开的项目从列表里删掉，
   * 而旧项目在没有模块时又不会被写回，于是「点过往的项目，那个项目就消失」）。
   * 已经打开的项目再次点击是安全的空操作。
   */
  function openProject(id) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: '项目不存在' };
    if (id === currentProjectId()) {
      return { ok: true, name: currentProjectName(), moduleCount: state.modules.length, noop: true };
    }
    var list = readJSON(PROJECTS_KEY, []);
    if (!Array.isArray(list)) return { ok: false, reason: '项目不存在' };
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { target = list[i]; break; }
    }
    if (!target) return { ok: false, reason: '项目不存在' };

    saveCurrentProject();          // 当前项目原地存回（含 0 模块的空项目），不新增条目

    var seen = {};
    var modules = [];
    var incoming = Array.isArray(target.modules) ? target.modules : [];
    for (var k = 0; k < incoming.length; k++) {
      var mod = normalizeModule(incoming[k], seen);
      if (mod) { modules.push(mod); seen[mod.id] = true; }
    }
    writeJSON(CURRENT_ID_KEY, id);
    state.modules = modules;
    state.activeModuleId = modules.length ? pickModuleId({ modules: modules }, target.activeModuleId) : null;
    setProjectName((typeof target.name === 'string' && target.name) ? target.name : PROJECT_NAME_DEFAULT);
    emit('project:open', { id: id, name: target.name });
    return { ok: true, name: target.name, moduleCount: modules.length };
  }

  /* ------------------------------------------------------------------
   * 流程模块规格（FLOW_STEPS）
   *   按业务流程图整理：两阶段共 9 步，每步给出「目标 / 要做的事 / 产出 / 验收要点」，
   *   供模块空间展示"这个模块要做什么"。文案可自行修改，改这里即可。
   * ------------------------------------------------------------------ */
  var FLOW_STEPS = [
    { key: 'literature', name: '① 文献调研', spec: {
      goal: '弄清这个题目别人已经做到哪一步，空白在哪里。',
      todo: ['围绕选题检索相关文献（近 5 年为主，含综述与高被引工作）',
             '逐篇记录：研究问题、数据来源、方法、结论',
             '归纳共识与分歧，指出现有工作的不足'],
      output: '文献清单 + 综述要点（每篇的贡献与局限）',
      acceptance: '覆盖主要工作；能指出至少 1 个具体空白；每条结论可溯源（作者/年份/来源）'
    } },
    { key: 'question', name: '② 科学问题的凝练与提取', spec: {
      goal: '把文献空白转成可检验的科学问题。',
      todo: ['从空白中提炼 1 个可验证的问题或假设',
             '明确研究对象、关键变量与边界条件',
             '说明为什么值得做（意义与预期贡献）'],
      output: '一句话研究问题 + 假设 + 边界条件',
      acceptance: '问题可验证；变量与边界清晰；与文献空白一一对应'
    } },
    { key: 'data', name: '③ 数据获取、清洗处理', spec: {
      goal: '拿到可直接用于计算的高质量数据。',
      todo: ['确定数据来源与获取方式（活动数据 / 公开数据集 / 文献挖掘）',
             '用自然语言明确清洗标准（缺失、异常、单位、去重）',
             '按不同数据类型采用不同清洗方法，并留存记录'],
      output: '清洗后的数据集 + 清洗标准文档',
      acceptance: '清洗标准经人工确认；获取与清洗可复现；异常处理有记录'
    } },
    { key: 'model', name: '④ 模型的选择与运行', spec: {
      goal: '选定方法并把结果跑出来。',
      todo: ['依据问题性质选择模型/方法，并说明选择理由',
             '明确输入、参数与评价指标',
             '运行并保存结果与运行日志'],
      output: '模型/方法说明 + 结果数据 + 运行日志',
      acceptance: '结果可复现（含参数与版本）；结果经人工检查'
    } },
    { key: 'chart', name: '⑤ 图表的绘制', spec: {
      goal: '把结果组织成"一眼能读懂"的证据。',
      todo: ['明确每张图要回答哪个问题',
             '选择合适图型（趋势 / 对比 / 分布 / 关系）',
             '统一坐标轴、单位、图例与配色'],
      output: '图表文件（矢量优先）+ 图注',
      acceptance: '每张图配图注即可独立读懂；无坐标/量纲/误导性刻度问题'
    } },
    { key: 'writing', name: '⑥ 文章的撰写和修改', spec: {
      goal: '形成逻辑闭环的完整稿件。',
      todo: ['按目标期刊结构撰写（引言/方法/结果/讨论/结论）',
             '让每个结论都能追溯到图表或数据',
             '逐轮修改，保留版本以便回看'],
      output: '稿件全文（含图表与参考文献）',
      acceptance: '结论均有数据支撑；结构完整；格式符合目标期刊要求'
    } },
    { key: 'submit', name: '⑦ 投稿前的全流程校验与投稿', spec: {
      goal: '投出去之前把全流程自查一遍。',
      todo: ['校验数据 / 代码 / 图表 / 稿件四者一致（文中数字与图一致）',
             '核对格式、作者信息、资助与伦理声明',
             '生成投稿材料并完成投稿'],
      output: '投稿材料 + 自查清单',
      acceptance: '自查清单逐项通过；稿件版本与投稿材料一致'
    } },
    { key: 'rebuttal', name: '⑧ 回复评审意见与最终校验', spec: {
      goal: '逐条回应评审意见并完成终稿。',
      todo: ['拆解评审意见并分类（接受 / 需补充 / 有异议）',
             '补实验或补充说明，撰写逐点回复',
             '修改稿件后做一次全文一致性校验'],
      output: '逐点回复 + 修改稿',
      acceptance: '每条意见都有明确落点（改了哪里）；修改后全文数字与图表一致'
    } },
    { key: 'proof', name: '⑨ 文章接收后校稿阶段的校验', spec: {
      goal: '保证见刊版与终稿一致。',
      todo: ['逐项核对校样与终稿差异',
             '检查作者、单位、基金、图表编号与引用',
             '确认版权与出版信息'],
      output: '校样确认 + 勘误记录（如有）',
      acceptance: '校样差异逐项确认；无遗留的编号/引用错误'
    } }
  ];

  function normalizeStatus(value) {
    return MODULE_STATUSES.indexOf(value) >= 0 ? value : 'todo';
  }

  /**
   * 开始业务流程：**只建第 1 步**，后续步骤在每一步通过审核后由 approveModule 自动补齐。
   * （原 initFlowModules 一次性建 9 个的行为保留，供需要一次铺满的场景使用。）
   * -> { ok, id, name, created }
   */
  function startFlow() {
    if (!FLOW_STEPS.length) return { ok: false, reason: '流程未定义' };
    var existed = false;
    for (var i = 0; i < state.modules.length; i++) {
      if (state.modules[i].step === FLOW_STEPS[0].key) { existed = true; break; }
    }
    var first = ensureFlowModule(FLOW_STEPS[0]);
    if (!findModule(state.activeModuleId)) state.activeModuleId = first.id;
    emit('flow:start', { id: first.id, name: first.name, created: !existed });
    return { ok: true, id: first.id, name: first.name, created: !existed };
  }

  /** 按流程一次性创建缺失的 9 个模块（已存在同 key 的跳过），并选中第一个新建模块 */
  function initFlowModules() {
    var created = [];
    for (var i = 0; i < FLOW_STEPS.length; i++) {
      var step = FLOW_STEPS[i];
      var exists = null;
      for (var j = 0; j < state.modules.length; j++) {
        if (state.modules[j].step === step.key) { exists = state.modules[j]; break; }
      }
      if (exists) continue;
      var last = state.modules.length ? state.modules[state.modules.length - 1] : null;
      var mod = {
        id: uid('mod_'),
        name: step.name,
        step: step.key,
        spec: deepClone(step.spec),
        status: 'todo',
        dependsOn: last ? last.id : null,
        createdAt: nowISO(),
        messages: [],
        doc: null,
        run: null
      };
      state.modules.push(mod);
      created.push(deepClone(mod));
    }
    if (!created.length) return { created: 0, firstId: null };
    if (!findModule(state.activeModuleId)) state.activeModuleId = created[0].id;
    emit('flow:init', { created: created.length, ids: created.map(function (m) { return m.id; }) });
    return { created: created.length, firstId: created[0].id };
  }

  /** 改模块状态：todo | doing | review | approved（非法值按 todo 处理） */
  function setModuleStatus(id, status) {
    var mod = findModule(id);
    if (!mod) return false;
    var next = normalizeStatus(status);
    if (mod.status === next) return true;
    mod.status = next;
    emit('module:status', { id: id, status: next });
    return true;
  }

  /** 提交人工审核（doing -> review） */
  function submitModule(id) {
    return setModuleStatus(id, 'review');
  }

  /**
   * 人工审核通过：置 approved，并自动把选中模块切到链上的下一个模块。
   * -> { ok, nextId, nextName }（已是最后一个模块时 nextId 为 null）
   */
  function approveModule(id) {
    var mod = findModule(id);
    if (!mod) return { ok: false, reason: '模块不存在' };
    var idx = indexOfModule(id);
    var next = (idx >= 0 && idx + 1 < state.modules.length) ? state.modules[idx + 1] : null;
    var created = null;
    mod.status = 'approved';
    mod.approvedAt = nowISO();
    if (!next) {
      // 【本地修复 · 2026-09-24】按步解锁：链上还没有下一个模块时，
      // 若还有后续步骤就现场建一个（名字与说明取自 FLOW_STEPS），再跳过去。
      created = buildNextFlowModule(mod);
      next = created;
    }
    if (next) state.activeModuleId = next.id;
    emit('module:status', {
      id: id, status: 'approved', nextId: next ? next.id : null,
      createdId: created ? created.id : null
    });
    return {
      ok: true,
      nextId: next ? next.id : null,
      nextName: next ? next.name : null,
      created: created ? deepClone(created) : null
    };
  }

  /** 该模块的 step 在 FLOW_STEPS 里的下标；不是流程模块返回 -1 */
  function flowIndexOf(stepKey) {
    for (var i = 0; i < FLOW_STEPS.length; i++) if (FLOW_STEPS[i].key === stepKey) return i;
    return -1;
  }

  /** 把某个步骤建成模块并追加到链尾；已存在同 step 的则直接返回它 */
  function ensureFlowModule(step) {
    for (var i = 0; i < state.modules.length; i++) {
      if (state.modules[i].step === step.key) return state.modules[i];
    }
    var last = state.modules.length ? state.modules[state.modules.length - 1] : null;
    var mod = {
      id: uid('mod_'),
      name: step.name,
      step: step.key,
      spec: deepClone(step.spec),
      status: 'todo',
      dependsOn: last ? last.id : null,
      createdAt: nowISO(),
      messages: []
    };
    state.modules.push(mod);
    return mod;
  }

  /** 审核通过后该出现的那一步：非流程模块或已是最后一步则返回 null */
  function buildNextFlowModule(approved) {
    var i = flowIndexOf(approved.step);
    if (i < 0 || i + 1 >= FLOW_STEPS.length) return null;
    return ensureFlowModule(FLOW_STEPS[i + 1]);
  }

  /** 人工审核打回（review -> doing），可附一句原因（写入系统消息） */
  function rejectModule(id, note) {
    var mod = findModule(id);
    if (!mod) return false;
    var text = (typeof note === 'string') ? note.trim() : '';
    mod.status = 'doing';
    if (text) {
      mod.messages.push({ id: uid('msg_'), role: 'system', text: '审核打回：' + text, at: nowISO() });
    }
    emit('module:status', { id: id, status: 'doing', note: text });
    return true;
  }

  /** 追加模块到链尾：dependsOn = 当前最后一个模块 id（保证强依赖 A→B→C）；同时选中新模块 */
  function addModule(name) {
    var list = state.modules;
    var nm = (typeof name === 'string') ? name.trim() : '';
    if (!nm) {
      var n = list.length + 1;
      var used = {};
      for (var i = 0; i < list.length; i++) used[list[i].name] = true;
      while (used['模块' + n]) n += 1;
      nm = '模块' + n; // 自动命名：模块1 / 模块2 / 模块3 …
    }
    var last = list.length ? list[list.length - 1] : null;
    var mod = {
      id: uid('mod_'),
      name: nm,
      dependsOn: last ? last.id : null,
      status: 'todo',
      createdAt: nowISO(),
      messages: [],
      doc: null,
      run: null
    };
    list.push(mod);
    state.activeModuleId = mod.id;
    emit('module:add', {
      module: deepClone(mod),
      index: list.length - 1,
      activeModuleId: mod.id
    });
    return deepClone(mod);
  }

  /** 选中模块；id 非法返回 false；已选中同一模块返回 true 且不触发 emit */
  function selectModule(id) {
    if (!findModule(id)) return false;
    if (state.activeModuleId === id) return true;
    state.activeModuleId = id;
    emit('module:select', { id: id });
    return true;
  }

  /** 删除模块：存在依赖它的下游模块时必须拒绝 */
  function removeModule(id) {
    var idx = indexOfModule(id);
    if (idx < 0) return { ok: false, reason: '模块不存在' };
    for (var i = 0; i < state.modules.length; i++) {
      if (state.modules[i].dependsOn === id) {
        return { ok: false, reason: '有下游模块依赖，不能删除' };
      }
    }
    var removed = state.modules.splice(idx, 1)[0];
    if (state.activeModuleId === id) {
      state.activeModuleId = state.modules.length ? state.modules[state.modules.length - 1].id : null;
    }
    emit('module:remove', {
      id: id,
      module: deepClone(removed),
      activeModuleId: state.activeModuleId
    });
    return { ok: true };
  }

  /** 重命名模块；name 去首尾空白后为空或模块不存在 -> false */
  function renameModule(id, name) {
    var nm = (typeof name === 'string') ? name.trim() : '';
    if (!nm) return false;
    var mod = findModule(id);
    if (!mod) return false;
    if (mod.name === nm) return true;
    mod.name = nm;
    emit('module:rename', { id: id, name: nm });
    return true;
  }

  /**
   * 追加消息。返回新增 message 的深拷贝；text 去首尾空白后为空 / 模块不存在 -> null。
   * role 非 user|assistant|system 时按 "user" 处理。不会改变 activeModuleId。
   */
  function appendMessage(moduleId, text, role) {
    var mod = findModule(moduleId);
    if (!mod) return null;
    var body = (text === null || typeof text === 'undefined') ? '' : String(text);
    body = body.trim();
    if (!body) return null;
    if (body.length > MAX_MESSAGE_CHARS) return null; // 超长拒绝，UI 层负责提示
    var r = (typeof role === 'string' && ROLES.indexOf(role) >= 0) ? role : 'user';
    var msg = { id: uid('msg_'), role: r, text: body, at: nowISO() };
    mod.messages.push(msg);
    emit('message:append', { moduleId: moduleId, message: deepClone(msg), role: r });
    return deepClone(msg);
  }

  /* ------------------------------------------------------------------
   * 环节文档（v7 新增，见契约 §16）
   *   每个模块可挂一份「用户与 AI 协商的标准文档」，作为环节间契约，支持人工审核：
   *     draft（草稿） --approveDoc--> approved（已通过）
   *     approved --rejectDoc(note)--> draft（打回，note 写入系统消息）
   *     任何一次 saveDoc（改稿）都会把状态打回 draft 并清空 approvedAt。
   *   全部同步；风格对齐 appendMessage（校验入参 → 先落盘 → 再 emit → 返回深拷贝）。
   * ------------------------------------------------------------------ */

  /**
   * 保存/更新某模块的环节文档。返回 doc 的深拷贝；下列情况返回 null（不改变状态）：
   *   - 模块不存在；content 非字符串；content.trim() 为空；content 长度 > MAX_DOC_CHARS。
   * 首次创建 status='draft'；已存在则覆盖 content 并把 status 打回 'draft'、approvedAt=null。
   */
  function saveDoc(moduleId, content) {
    var mod = findModule(moduleId);
    if (!mod) return null;
    if (typeof content !== 'string') return null;
    var body = content.trim();
    if (!body) return null;
    if (body.length > MAX_DOC_CHARS) return null; // 超长拒绝，UI 层负责提示
    var created = !(mod.doc && typeof mod.doc === 'object');
    mod.doc = {
      content: body,
      status: 'draft',
      updatedAt: nowISO(),
      approvedAt: null
    };
    emit('doc:save', { moduleId: moduleId, doc: deepClone(mod.doc), created: created });
    return deepClone(mod.doc);
  }

  /** 人工审核通过：无 doc 返回 false；否则置 approved + approvedAt=now，emit 'doc:approve' */
  function approveDoc(moduleId) {
    var mod = findModule(moduleId);
    if (!mod || !mod.doc) return false;
    mod.doc.status = 'approved';
    mod.doc.approvedAt = nowISO();
    mod.doc.updatedAt = nowISO();
    emit('doc:approve', { moduleId: moduleId, doc: deepClone(mod.doc) });
    return true;
  }

  /**
   * 人工审核打回：无 doc 返回 false；否则置回 draft（approvedAt=null）。
   * note 去首尾空白后非空时，向该模块消息流追加一条 system 消息「文档打回：<note>」。
   */
  function rejectDoc(moduleId, note) {
    var mod = findModule(moduleId);
    if (!mod || !mod.doc) return false;
    var text = (typeof note === 'string') ? note.trim() : '';
    mod.doc.status = 'draft';
    mod.doc.approvedAt = null;
    if (text) {
      mod.messages.push({ id: uid('msg_'), role: 'system', text: '文档打回：' + text, at: nowISO() });
    }
    emit('doc:reject', { moduleId: moduleId, note: text, doc: deepClone(mod.doc) });
    return true;
  }

  /* ------------------------------------------------------------------
   * 执行记录与结果确认门（v8 新增，见契约 §18）
   *   每个模块可挂一份「执行记录」，记录本次运行的结果（状态 / 时间 / 工作目录 / 产物）：
   *     (null) --markRun--> ran --confirmRun--> confirmed
   *                          `--rejectRun(cause,note)--> (null)（打回，归因写入系统消息）
   *   设计原话：『数据一旦出错后面全白干，结果必须人确认』—— 因此 ran 只是"跑完了"，
   *   必须经 confirmRun 人工确认才算通过；rejectRun 时连同三级归因（数据/代码/标准）打回。
   *   全部同步；风格对齐 saveDoc（校验入参 → 先落盘 → 再 emit → 返回深拷贝）。
   * ------------------------------------------------------------------ */

  /**
   * 记录一次执行结果。返回 run 的深拷贝；模块不存在 -> null。
   * info = { dir?, artifacts? }（均可选）：dir 非字符串按 '' 处理；artifacts 仅保留 {name,size} 合法项。
   * 无论此前是否有 run，本次都会用 status='ran'、at=now 覆盖（再次执行即重新进入待确认）。
   */
  function markRun(moduleId, info) {
    var mod = findModule(moduleId);
    if (!mod) return null;
    var src = (info && typeof info === 'object' && !Array.isArray(info)) ? info : {};
    var artifacts = [];
    if (Array.isArray(src.artifacts)) {
      for (var i = 0; i < src.artifacts.length; i++) {
        var art = src.artifacts[i];
        if (!art || typeof art !== 'object' || typeof art.name !== 'string' || !art.name) continue;
        artifacts.push({
          name: art.name,
          size: (typeof art.size === 'number' && isFinite(art.size)) ? art.size : 0
        });
      }
    }
    mod.run = {
      status: 'ran',
      at: nowISO(),
      dir: (typeof src.dir === 'string') ? src.dir : '',
      artifacts: artifacts
    };
    emit('run:mark', { moduleId: moduleId, run: deepClone(mod.run) });
    return deepClone(mod.run);
  }

  /** 人工确认执行结果：无 run 或 status!=='ran' 返回 false；否则置 confirmed，emit 'run:confirm' */
  function confirmRun(moduleId) {
    var mod = findModule(moduleId);
    if (!mod || !mod.run || mod.run.status !== 'ran') return false;
    mod.run.status = 'confirmed';
    emit('run:confirm', { moduleId: moduleId, run: deepClone(mod.run) });
    return true;
  }

  /**
   * 结果复核打回：cause 必须是 'data' | 'code' | 'doc'（否则 false）；无 run 或模块不存在 -> false。
   * 成功则把 run 清空（置 null），并向该模块消息流追加系统消息
   * 「结果复核打回（归因：数据/代码/标准）」（note 去首尾空白后非空时追加 '：' + note）。
   */
  function rejectRun(moduleId, cause, note) {
    if (RUN_CAUSES.indexOf(cause) < 0) return false;
    var mod = findModule(moduleId);
    if (!mod || !mod.run) return false;
    var text = (typeof note === 'string') ? note.trim() : '';
    var body = '结果复核打回（归因：' + RUN_CAUSE_LABELS[cause] + '）';
    if (text) body += '：' + text;
    mod.run = null;
    mod.messages.push({ id: uid('msg_'), role: 'system', text: body, at: nowISO() });
    emit('run:reject', { moduleId: moduleId, cause: cause, note: text });
    return true;
  }

  /**
   * 更新侧栏：patch.collapsed 布尔、patch.width 数字（可转数字的字符串也接受）夹取 180~520。
   * 仅在值真正变化时才 emit "sidebar:change"。返回新的 sidebar 深拷贝。
   */
  function setSidebar(patch) {
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      var changed = [];
      if (typeof patch.collapsed === 'boolean' && patch.collapsed !== state.sidebar.collapsed) {
        state.sidebar.collapsed = patch.collapsed;
        changed.push('collapsed');
      }
      if (typeof patch.width !== 'undefined' && patch.width !== null) {
        var w = clampWidth(patch.width);
        if (w !== null && w !== state.sidebar.width) {
          state.sidebar.width = w;
          changed.push('width');
        }
      }
      if (changed.length) {
        emit('sidebar:change', {
          collapsed: state.sidebar.collapsed,
          width: state.sidebar.width,
          changed: changed
        });
      }
    }
    return deepClone(state.sidebar);
  }

  /** 切换左侧栏选项卡；id 非法返回 false；同一选项卡返回 true 且不 emit */
  function selectTab(id) {
    var found = null;
    for (var i = 0; i < state.tabs.length; i++) {
      if (state.tabs[i].id === id) found = state.tabs[i];
    }
    if (!found) return false;
    if (state.activeTabId === id) return true;
    state.activeTabId = id;
    emit('tab:select', { id: id, name: found.name });
    return true;
  }

  /** 清空回默认（便于调试）：内存重置 -> 落盘默认值 -> emit "state:reset" */
  function resetAll() {
    state = defaultState();
    emit('state:reset', { state: deepClone(state) });
    return deepClone(state);
  }

  root.Store = {
    // —— 状态读写
    getState: getState,
    subscribe: subscribe,
    // —— 模块链
    addModule: addModule,
    selectModule: selectModule,
    removeModule: removeModule,
    renameModule: renameModule,
    appendMessage: appendMessage,
    // —— 流程模块与人工审核（规格 + 状态机）
    initFlowModules: initFlowModules,
    startFlow: startFlow,
    setModuleStatus: setModuleStatus,
    submitModule: submitModule,
    approveModule: approveModule,
    rejectModule: rejectModule,
    // —— 环节文档（用户与 AI 协商的标准文档 + 人工审核）
    saveDoc: saveDoc,
    approveDoc: approveDoc,
    rejectDoc: rejectDoc,
    // —— 执行记录与结果确认门（跑完待确认 + 三级归因打回）
    markRun: markRun,
    confirmRun: confirmRun,
    rejectRun: rejectRun,
    // —— 项目管理（本地多项目：归档 / 新建 / 打开）
    createProject: createProject,
    openProject: openProject,
    listProjects: listProjects,
    currentProjectName: currentProjectName,
    // —— 侧栏 / 选项卡
    setSidebar: setSidebar,
    selectTab: selectTab,
    resetAll: resetAll,
    // —— 常量（可选使用，避免各处硬编码字符串）
    EVENT: {
      MODULE_ADD: 'module:add',
      MODULE_SELECT: 'module:select',
      MODULE_REMOVE: 'module:remove',
      MODULE_RENAME: 'module:rename',
      MESSAGE_APPEND: 'message:append',
      SIDEBAR_CHANGE: 'sidebar:change',
      TAB_SELECT: 'tab:select',
      STATE_RESET: 'state:reset',
      MODULE_STATUS: 'module:status',
      FLOW_INIT: 'flow:init',
      PROJECT_CREATE: 'project:create',
      PROJECT_OPEN: 'project:open',
      DOC_SAVE: 'doc:save',
      DOC_APPROVE: 'doc:approve',
      DOC_REJECT: 'doc:reject',
      RUN_MARK: 'run:mark',
      RUN_CONFIRM: 'run:confirm',
      RUN_REJECT: 'run:reject'
    },
    LIMITS: {
      STORAGE_KEY: STORAGE_KEY,
      SIDEBAR_MIN: SIDEBAR_MIN,
      SIDEBAR_MAX: SIDEBAR_MAX,
      SIDEBAR_DEFAULT: SIDEBAR_DEFAULT,
      MAX_MESSAGE_CHARS: MAX_MESSAGE_CHARS,
      MAX_DOC_CHARS: MAX_DOC_CHARS,
      ROLES: ROLES.slice(),
      MODULE_STATUSES: MODULE_STATUSES.slice(),
      DOC_STATUSES: DOC_STATUSES.slice(),
      RUN_STATUSES: RUN_STATUSES.slice()
    },
    // 流程规格（只读快照）：9 步的 key / 名称 / 说明
    FLOW_STEPS: deepClone(FLOW_STEPS),
    // 存储键常量（项目管理用）
    PROJECTS_KEY: PROJECTS_KEY,
    PROJECT_META_KEY: PROJECT_META_KEY,
    // 【本地修复 · 2026-09-24】当前项目 id / 把当前项目原地存回列表
    CURRENT_ID_KEY: CURRENT_ID_KEY,
    currentProjectId: currentProjectId,
    saveCurrentProject: saveCurrentProject,
    deleteProject: deleteProject
  };
})(typeof window !== 'undefined' ? window : this);
