/*!
 * 流程智能体 —— 模块独立空间 + 底部输入区（T4 交付）
 * 全局对象：window.ModuleSpace = { render }
 *
 * 职责
 *  1) render()：读 Store.getState()，渲染 #module-space 内部
 *     （.module-header / .msg-list / .empty-state），并只更新 #composer-input / #btn-send 的
 *     disabled / placeholder —— 绝不重建 #composer / #composer-input / #btn-send 静态节点，
 *     以免丢焦点与半截输入。渲染末尾把 #module-space 滚到底部。
 *  2) 交互：脚本加载期只绑定一次 #btn-send click、#composer-input keydown / input。
 *     Enter（非 Shift、且非输入法合成中）发送；Shift+Enter 换行；输入框高度自适应（上限 180px）。
 *
 * 约束：零依赖；无 module / fetch / crypto.subtle / 外部 CDN；脚本在 </body> 之前，
 *      不使用 DOMContentLoaded；不调用其它模块的 render；render() 幂等、可高频调用；
 *      消息文本一律用 textContent 写入（不做 HTML 拼接）。
 *      不写 Store（无选中模块时仅在渲染层兜底取链尾模块，不改状态）。
 */
;(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 文案常量
  var PLACEHOLDER_DEFAULT = '输入内容…（Enter 发送，Shift+Enter 换行）';
  var PLACEHOLDER_NO_MODULE = '请先点击上方 ＋ 添加模块';
  var PLACEHOLDER_NO_ACTIVE = '请选择一个模块';
  var EMPTY_NO_MODULE_TITLE = '还没有模块';
  var EMPTY_NO_MODULE_HINT = '点击上方 ＋ 添加第一个模块';
  var HINT_TEXT = '演示前端：未接入模型服务，消息仅保存在本地浏览器';
  var MAX_INPUT_HEIGHT = 180; // 与 css/style.css 中 .composer-input { max-height } 保持一致

  var ROLE_CLASS = {
    user: 'msg msg-user',
    assistant: 'msg msg-assistant',
    system: 'msg msg-system'
  };

  // ---------------------------------------------------- 静态节点引用（DOM 已就绪）
  var spaceEl = document.getElementById('module-space');
  var inputEl = document.getElementById('composer-input');
  var sendEl = document.getElementById('btn-send');
  var hintEl = document.querySelector('#composer .composer-hint');

  // -------------------------------------------------------------------- 工具

  function getStore() {
    return (root && root.Store) ? root.Store : null;
  }

  /** 创建元素：className 可选，text 走 textContent（禁止 HTML 拼接） */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  /** 空状态块：标题 + 提示 */
  function emptyState(title, hint) {
    var box = el('div', 'empty-state');
    box.appendChild(el('div', 'empty-state-title', title));
    box.appendChild(el('div', 'empty-state-hint', hint));
    return box;
  }

  function findModule(list, id) {
    if (!list || !id) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /** 依赖来源文案：首模块「起点」，其余「← 上游模块名」 */
  function depLabel(list, module) {
    if (!module.dependsOn) return '起点';
    var up = findModule(list, module.dependsOn);
    return up ? '← ' + up.name : '起点';
  }

  /** ISO 时间 -> HH:mm:ss（本地时区）；非法/缺失返回空串 */
  function formatTime(iso) {
    var d = new Date(iso);
    if (!d || isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return d.toTimeString().slice(0, 8);
    }
  }

  /** 输入框高度自适应：先归零再按 scrollHeight 撑开，上限 MAX_INPUT_HEIGHT */
  function autoGrow(node) {
    if (!node || !node.style) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
  }

  /**
   * 只改静态节点属性：输入框/发送按钮的禁用态与占位文案。
   * 不动 value、不动焦点、不重建节点。
   */
  function setComposerEnabled(enabled, placeholder) {
    if (inputEl) {
      inputEl.disabled = !enabled;
      if (typeof placeholder === 'string') inputEl.placeholder = placeholder;
    }
    if (sendEl) sendEl.disabled = !enabled;
  }

  /** 单条消息：.msg.msg-user|.msg-assistant|.msg-system > .msg-text + .msg-meta */
  function buildMessage(msg) {
    var role = (msg && msg.role) || 'user';
    var wrap = el('div', ROLE_CLASS[role] || ROLE_CLASS.user);
    if (msg && msg.id) wrap.setAttribute('data-id', msg.id);
    wrap.setAttribute('data-role', role);
    wrap.appendChild(el('div', 'msg-text', (msg && typeof msg.text === 'string') ? msg.text : ''));
    var time = msg ? formatTime(msg.at) : '';
    if (time) wrap.appendChild(el('div', 'msg-meta', time));
    return wrap;
  }

  /** 取当前可发送的模块 id：模块必须真实存在（Store 保证；这里再兜底校验一次） */
  function activeModuleId() {
    var Store = getStore();
    if (!Store) return null;
    var state = Store.getState();
    if (!state || !state.activeModuleId) return null;
    var mod = findModule(state.modules || [], state.activeModuleId);
    return mod ? mod.id : null;
  }

  // ------------------------------------------------------------------ 渲染

  /**
   * 渲染模块独立空间 + 输入区状态。幂等：只重建 #module-space 内部（自己的容器）。
   * 无模块 / 未选中模块时禁用输入框，并给出对应占位提示。
   */
  function render() {
    if (!spaceEl) spaceEl = document.getElementById('module-space');
    if (!spaceEl) return;

    var Store = getStore();
    var state = Store ? Store.getState() : null;
    var modules = (state && state.modules) ? state.modules : [];
    var active = findModule(modules, state ? state.activeModuleId : null);
    var fallback = false; // activeModuleId 缺失时的渲染层兜底（不写 Store）

    if (!active && modules.length) {
      active = modules[modules.length - 1];
      fallback = true;
    }

    spaceEl.innerHTML = '';

    if (!modules.length) {
      // 无模块：空状态 + 禁用输入
      spaceEl.appendChild(emptyState(EMPTY_NO_MODULE_TITLE, EMPTY_NO_MODULE_HINT));
      setComposerEnabled(false, PLACEHOLDER_NO_MODULE);
    } else if (!active) {
      // 理论上不可达（modules 非空必有兜底），保底走同一分支
      spaceEl.appendChild(emptyState(EMPTY_NO_MODULE_TITLE, EMPTY_NO_MODULE_HINT));
      setComposerEnabled(false, PLACEHOLDER_NO_MODULE);
    } else {
      var messages = active.messages || [];

      var header = el('div', 'module-header');
      header.appendChild(el('div', 'module-header-title', active.name));
      header.appendChild(el('div', 'module-header-meta',
        '依赖：' + depLabel(modules, active) + ' · 消息 ' + messages.length + ' 条'));
      spaceEl.appendChild(header);

      var list = el('div', 'msg-list');
      if (!messages.length) {
        list.appendChild(emptyState(active.name,
          '这是「' + active.name + '」的独立空间，在下方输入内容开始'));
      } else {
        for (var i = 0; i < messages.length; i++) list.appendChild(buildMessage(messages[i]));
      }
      spaceEl.appendChild(list);

      // 有明确选中的模块才允许输入；兜底渲染（activeModuleId 缺失）时保持禁用
      if (fallback) {
        setComposerEnabled(false, PLACEHOLDER_NO_ACTIVE);
      } else {
        setComposerEnabled(true, PLACEHOLDER_DEFAULT);
      }
    }

    // 渲染完成 -> 滚到底部
    spaceEl.scrollTop = spaceEl.scrollHeight;
  }

  // ------------------------------------------------------------------ 发送

  /** 发送：取输入框文本 -> Store.appendMessage(activeModuleId, text, 'user')；失败不动输入框 */
  function send() {
    if (!inputEl) inputEl = document.getElementById('composer-input');
    if (!inputEl) return;
    var id = activeModuleId();
    if (!id) return;                                    // 无选中模块 / 模块不存在 -> 忽略
    var msg = getStore().appendMessage(id, inputEl.value, 'user');
    if (!msg) return;                                   // 空文本被 Store 拒绝 -> 保留原输入
    inputEl.value = '';
    autoGrow(inputEl);
    render();                                           // 自渲染兜底（app.js 订阅后也会再渲染一次）
  }

  // -------------------------------------------------------------- 加载期绑定

  if (hintEl) hintEl.textContent = HINT_TEXT;           // 静态节点：只改文本

  if (inputEl) {
    inputEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;      // Shift+Enter：交给浏览器换行，不拦截
      if (e.isComposing || e.keyCode === 229) return;   // 输入法候选未上屏时回车不上屏即发送会误发
      e.preventDefault();
      send();
    });
    inputEl.addEventListener('input', function () {
      autoGrow(inputEl);
    });
    autoGrow(inputEl);
  }

  if (sendEl) {
    sendEl.addEventListener('click', function () {
      send();
    });
  }

  root.ModuleSpace = { render: render };
})(typeof window !== 'undefined' ? window : this);
