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
 *   messages: [ message ]
 * }
 * message = { id:"msg_xxx", role:"user"|"assistant"|"system", text:"非空字符串", at:"ISO 字符串" }
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
 *   setSidebar({collapsed,width})          -> sidebar 深拷贝（width 夹取 180~520）
 *   selectTab(id)                          -> boolean
 *   resetAll()                             -> 重置为默认 state 深拷贝
 *
 * 变更事件 type 约定：
 *   module:add / module:select / module:remove / module:rename / message:append / sidebar:change / tab:select / state:reset
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
  var TABS_DEFAULT = [{ id: 'flow', name: '流程' }];
  var ROLES = ['user', 'assistant', 'system'];
  // 必须与其他常量一起放在顶部：normalizeModule() 在**文件开头加载 localStorage** 时就会用到它
  // （若把它声明在文件后段，var 提升会让加载期的值为 undefined → 归一化抛错 → 状态回退成空）。
  var MODULE_STATUSES = ['todo', 'doing', 'review', 'approved'];

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

    var out = {
      id: id, name: name, dependsOn: dependsOn, createdAt: createdAt,
      messages: messages, status: normalizeStatus(raw.status)
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
        messages: []
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
    mod.status = 'approved';
    mod.approvedAt = nowISO();
    if (next) state.activeModuleId = next.id;
    emit('module:status', {
      id: id, status: 'approved', nextId: next ? next.id : null
    });
    return { ok: true, nextId: next ? next.id : null, nextName: next ? next.name : null };
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
      messages: []
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
    var r = (typeof role === 'string' && ROLES.indexOf(role) >= 0) ? role : 'user';
    var msg = { id: uid('msg_'), role: r, text: body, at: nowISO() };
    mod.messages.push(msg);
    emit('message:append', { moduleId: moduleId, message: deepClone(msg), role: r });
    return deepClone(msg);
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
    setModuleStatus: setModuleStatus,
    submitModule: submitModule,
    approveModule: approveModule,
    rejectModule: rejectModule,
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
      FLOW_INIT: 'flow:init'
    },
    LIMITS: {
      STORAGE_KEY: STORAGE_KEY,
      SIDEBAR_MIN: SIDEBAR_MIN,
      SIDEBAR_MAX: SIDEBAR_MAX,
      SIDEBAR_DEFAULT: SIDEBAR_DEFAULT,
      ROLES: ROLES.slice(),
      MODULE_STATUSES: MODULE_STATUSES.slice()
    },
    // 流程规格（只读快照）：9 步的 key / 名称 / 说明
    FLOW_STEPS: deepClone(FLOW_STEPS)
  };
})(typeof window !== 'undefined' ? window : this);
