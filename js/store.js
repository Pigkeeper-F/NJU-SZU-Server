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
    return { id: id, name: name, dependsOn: dependsOn, createdAt: createdAt, messages: messages };
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
      STATE_RESET: 'state:reset'
    },
    LIMITS: {
      STORAGE_KEY: STORAGE_KEY,
      SIDEBAR_MIN: SIDEBAR_MIN,
      SIDEBAR_MAX: SIDEBAR_MAX,
      SIDEBAR_DEFAULT: SIDEBAR_DEFAULT,
      ROLES: ROLES.slice()
    }
  };
})(typeof window !== 'undefined' ? window : this);
