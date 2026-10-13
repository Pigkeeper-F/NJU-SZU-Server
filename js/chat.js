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
 * 约束：零依赖；无 module / crypto.subtle / 外部 CDN；脚本在 </body> 之前，
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
  var HINT_TEXT = 'AI 回复由本地服务代理；API Key 不会发送到浏览器';
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
  var pendingModules = {};
  // 【安全修复 · 2026-10-13】增量渲染追踪：消息是 append-only 的（Store 没有 edit/remove
  // 单条消息的 API），同模块且状态未变时只需向 .msg-list 追加新消息，避免每次状态变更
  // 全量重建整个消息列表（数百条消息时 O(n²) 卡顿）。任何不满足条件的场景落回全量。
  var msgListState = { moduleId: null, count: -1, firstId: null, status: null, pending: false };
  var MAX_INPUT_CHARS = (root.Store && root.Store.LIMITS && root.Store.LIMITS.MAX_MESSAGE_CHARS) || 20000; // 加载期与 Store 同步

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

  /* ------------------------------------------------------------------
   * 迷你 Markdown 渲染（体验升级 · 2026-10-13）
   *   只支持安全子集：``` 代码块、`行内代码`、**加粗**、*斜体*、- / 1. 列表、#~### 标题。
   *   全部经 document.createElement / textContent 构造，**不使用任何 innerHTML**，
   *   与「消息文本零 HTML 拼接」的注入防护约束完全兼容；不渲染链接（避免钓鱼面）。
   * ------------------------------------------------------------------ */

  /** 行内解析：**加粗** / *斜体* / `行内代码` → DocumentFragment */
  function renderInline(text) {
    var frag = document.createDocumentFragment();
    var pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
    var last = 0;
    var m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var token = m[0];
      if (token.indexOf('**') === 0) {
        var strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        frag.appendChild(strong);
      } else if (token.charAt(0) === '`') {
        var codeEl = document.createElement('code');
        codeEl.className = 'md-code';
        codeEl.textContent = token.slice(1, -1);
        frag.appendChild(codeEl);
      } else {
        var emEl = document.createElement('em');
        emEl.textContent = token.slice(1, -1);
        frag.appendChild(emEl);
      }
      last = m.index + token.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  /** 块级解析：段落 / 代码块 / 标题 / 列表 → DocumentFragment（全部 DOM API 构造） */
  function renderRichText(text) {
    var container = document.createDocumentFragment();
    var lines = String(text).split('\n');
    var paragraph = [];
    var i = 0;

    function flushParagraph() {
      if (!paragraph.length) return;
      var p = document.createElement('div');
      p.className = 'md-p';
      for (var k = 0; k < paragraph.length; k++) {
        if (k > 0) p.appendChild(document.createElement('br'));
        p.appendChild(renderInline(paragraph[k]));
      }
      container.appendChild(p);
      paragraph = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      if (line.indexOf('```') === 0) {                      // 代码块
        flushParagraph();
        var buf = [];
        i += 1;
        while (i < lines.length && lines[i].indexOf('```') !== 0) { buf.push(lines[i]); i += 1; }
        i += 1;                                             // 跳过结束围栏（缺失时容错）
        var pre = document.createElement('pre');
        pre.className = 'md-pre';
        var code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        container.appendChild(pre);
        continue;
      }

      var heading = line.match(/^(#{1,3})\s+(.+)$/);        // 标题（h1~h3 映射为 md-h1~3 字号）
      if (heading) {
        flushParagraph();
        var hEl = document.createElement('div');
        hEl.className = 'md-h md-h' + heading[1].length;
        hEl.appendChild(renderInline(heading[2]));
        container.appendChild(hEl);
        i += 1;
        continue;
      }

      var ul = line.match(/^\s*[-*]\s+(.+)$/);              // 无序列表
      if (ul) {
        flushParagraph();
        var ulEl = document.createElement('ul');
        ulEl.className = 'md-ul';
        while (i < lines.length) {
          var um = lines[i].match(/^\s*[-*]\s+(.+)$/);
          if (!um) break;
          var li = document.createElement('li');
          li.appendChild(renderInline(um[1]));
          ulEl.appendChild(li);
          i += 1;
        }
        container.appendChild(ulEl);
        continue;
      }

      var ol = line.match(/^\s*\d+[.)]\s+(.+)$/);           // 有序列表
      if (ol) {
        flushParagraph();
        var olEl = document.createElement('ol');
        olEl.className = 'md-ol';
        while (i < lines.length) {
          var om = lines[i].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!om) break;
          var li2 = document.createElement('li');
          li2.appendChild(renderInline(om[1]));
          olEl.appendChild(li2);
          i += 1;
        }
        container.appendChild(olEl);
        continue;
      }

      if (!line.trim()) {                                   // 空行 = 段落分隔
        flushParagraph();
        i += 1;
        continue;
      }

      paragraph.push(line);
      i += 1;
    }
    flushParagraph();
    return container;
  }

  /** 单条消息：.msg.msg-user|.msg-assistant|.msg-system > .msg-text + .msg-meta
   *  【体验升级 · 2026-10-13】用户/AI 消息经迷你 Markdown 渲染（纯 DOM 构造，零 innerHTML）；
   *  系统消息保持纯文本。 */
  function buildMessage(msg) {
    var role = (msg && msg.role) || 'user';
    var wrap = el('div', ROLE_CLASS[role] || ROLE_CLASS.user);
    if (msg && msg.id) wrap.setAttribute('data-id', msg.id);
    wrap.setAttribute('data-role', role);
    var textEl = el('div', 'msg-text');
    var raw = (msg && typeof msg.text === 'string') ? msg.text : '';
    if (role === 'system') {
      textEl.textContent = raw;
    } else {
      textEl.appendChild(renderRichText(raw));
    }
    wrap.appendChild(textEl);
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

  function messagesFor(moduleId) {
    var Store = getStore();
    var state = Store ? Store.getState() : null;
    var mod = state ? findModule(state.modules || [], moduleId) : null;
    if (!mod) return [];
    return (mod.messages || []).map(function (message) {
      return { role: message.role, text: message.text };
    });
  }

  /** 读取本机保存的模型设置（左下角齿轮）；没有配置返回 null */
  function readLlmSettings() {
    try {
      var raw = root.localStorage ? root.localStorage.getItem('fa_llm_settings_v1') : null;
      var s = raw ? JSON.parse(raw) : null;
      if (!s || typeof s !== 'object') return null;
      var out = {};
      if (typeof s.baseUrl === 'string' && s.baseUrl.trim()) out.baseUrl = s.baseUrl.trim();
      if (typeof s.model === 'string' && s.model.trim()) out.model = s.model.trim();
      if (typeof s.apiKey === 'string' && s.apiKey.trim()) out.apiKey = s.apiKey.trim();
      if (s.protocol === 'responses' || s.protocol === 'chat-completions') out.protocol = s.protocol;
      // 【体验升级 · 2026-10-13】系统提示词（可选）：由服务端注入为 system 指令
      if (typeof s.systemPrompt === 'string' && s.systemPrompt.trim()) out.systemPrompt = s.systemPrompt.trim().slice(0, 2000);
      return Object.keys(out).length ? out : null;
    } catch (error) { return null; }
  }

  function requestReply(moduleId) {
    pendingModules[moduleId] = true;
    render();
    return fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messagesFor(moduleId), settings: readLlmSettings() })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || 'AI 服务请求失败');
        if (!data || typeof data.text !== 'string') throw new Error('AI 服务返回了无效响应');
        return data.text;
      });
    }).then(function (text) {
      getStore().appendMessage(moduleId, text, 'assistant');
    }).catch(function (error) {
      getStore().appendMessage(moduleId, 'AI 回复失败：' + (error && error.message ? error.message : '未知错误'), 'system');
    }).finally(function () {
      delete pendingModules[moduleId];
      render();
    });
  }

  // ------------------------------------------- 流程规格与人工审核（说明卡 + 状态门控）

  var STATUS_META = {
    todo: { glyph: '○', text: '待开始' },
    doing: { glyph: '◐', text: '进行中' },
    review: { glyph: '⏳', text: '待审核' },
    approved: { glyph: '✓', text: '已通过' }
  };

  var STATUS_HINT = {
    todo: '先读上方说明，做完后点「完成并提交审核」',
    doing: '进行中：在下方记录进展，做完后提交人工审核',
    review: '待人工审核：确认无误点「确定（通过）」，会自动跳到下一个模块',
    approved: '已通过人工审核'
  };

  function statusOf(mod) {
    var s = mod && mod.status;
    return STATUS_META[s] ? s : 'todo';
  }

  function specRow(label, value) {
    var row = el('div', 'spec-row');
    row.appendChild(el('div', 'spec-label', label));
    row.appendChild(el('div', 'spec-value', value));
    return row;
  }

  /** 任务说明卡：目标 / 要做的事 / 产出 / 验收要点（无 spec 的模块返回 null） */
  function buildSpecCard(mod) {
    var spec = mod && mod.spec;
    if (!spec) return null;
    var card = el('div', 'spec-card');
    card.appendChild(el('div', 'spec-title', '本模块要做什么'));
    if (spec.goal) card.appendChild(specRow('目标', spec.goal));
    if (spec.todo && spec.todo.length) {
      var lines = [];
      for (var i = 0; i < spec.todo.length; i++) lines.push((i + 1) + '. ' + spec.todo[i]);
      card.appendChild(specRow('要做的事', lines.join('\n')));
    }
    if (spec.output) card.appendChild(specRow('产出', spec.output));
    if (spec.acceptance) card.appendChild(specRow('验收要点', spec.acceptance));
    return card;
  }

  function actionButton(text, kind, onClick) {
    var btn = el('button', 'status-btn' + (kind === 'primary' ? ' status-btn-primary' : ''), text);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      onClick();
      render();
    });
    return btn;
  }

  /** 状态条：状态徽标 + 审核动作（提交审核 / 通过 / 打回 / 进入下一模块） */
  function buildStatusBar(mod, modules) {
    var bar = el('div', 'status-bar');
    var st = statusOf(mod);
    var chip = el('span', 'status-chip', STATUS_META[st].glyph + ' ' + STATUS_META[st].text);
    chip.setAttribute('data-status', st);
    bar.appendChild(chip);
    bar.appendChild(el('span', 'status-hint', STATUS_HINT[st] || ''));

    var actions = el('div', 'status-actions');
    if (st === 'todo' || st === 'doing') {
      actions.appendChild(actionButton('完成并提交审核', 'primary', function () {
        getStore().submitModule(mod.id);
      }));
    } else if (st === 'review') {
      actions.appendChild(actionButton('确定（通过）', 'primary', function () {
        getStore().approveModule(mod.id);      // 内部已把选中切到下一模块
      }));
      actions.appendChild(actionButton('打回重做', 'ghost', function () {
        getStore().rejectModule(mod.id, '需要补充后再提交');
      }));
    } else if (st === 'approved') {
      var idx = -1;
      for (var i = 0; i < modules.length; i++) if (modules[i].id === mod.id) { idx = i; break; }
      var next = (idx >= 0 && idx + 1 < modules.length) ? modules[idx + 1] : null;
      if (next) {
        actions.appendChild(actionButton('进入下一模块：' + next.name + ' →', 'primary', function () {
          getStore().selectModule(next.id);
        }));
      } else {
        actions.appendChild(el('span', 'status-hint', '已是最后一个模块'));
      }
    }
    if (actions.childNodes.length) bar.appendChild(actions);
    return bar;
  }

  /** 空状态里的一键初始化：按业务流程图建 9 个模块（各自带任务说明） */
  function flowInitButton() {
    var btn = el('button', 'status-btn status-btn-primary flow-init-btn', '按业务流程初始化 9 个模块');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var Store = getStore();
      if (Store && Store.initFlowModules) Store.initFlowModules();
      render();
    });
    return btn;
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
    var messageless = true; // 当前模块没有消息（决定渲染后滚到顶部还是底部）

    if (!active && modules.length) {
      active = modules[modules.length - 1];
      fallback = true;
    }
    var messages = (active && active.messages) ? active.messages : [];

    // ---- 增量快速路径：纯消息追加（含 AI pending 指示翻转），其余一律全量 ----
    var pendingNow = active ? !!pendingModules[active.id] : false;
    var canFast = !!active && !fallback &&
      msgListState.moduleId === active.id &&
      msgListState.count >= 0 &&
      messages.length >= msgListState.count &&
      (msgListState.count === 0 || messages[0].id === msgListState.firstId) &&
      (active.status || 'todo') === msgListState.status &&
      pendingNow === msgListState.pending;
    if (canFast) {
      try {
        var fastList = spaceEl.querySelector('.msg-list');
        if (!fastList) throw new Error('msg-list missing');
        if (msgListState.count === 0) { // 首条消息：移除模块空状态提示
          var staleEmpty = fastList.querySelector('.empty-state');
          if (staleEmpty) staleEmpty.remove();
        }
        for (var fi = msgListState.count; fi < messages.length; fi++) {
          fastList.appendChild(buildMessage(messages[fi]));
        }
        // 模块名可能被重命名 / 条数变化：头部整体重建（节点少，代价可忽略）
        var oldHeader = spaceEl.querySelector('.module-header');
        if (oldHeader) {
          var fastHeader = el('div', 'module-header');
          fastHeader.appendChild(el('div', 'module-header-title', active.name));
          fastHeader.appendChild(el('div', 'module-header-meta',
            '依赖：' + depLabel(modules, active) + ' · 消息 ' + messages.length + ' 条'));
          oldHeader.replaceWith(fastHeader);
        }
        // AI pending 指示翻转
        var pendingEl = spaceEl.querySelector('.ai-pending');
        if (pendingNow && !pendingEl) spaceEl.appendChild(el('div', 'ai-pending', 'AI 正在思考…'));
        if (!pendingNow && pendingEl) pendingEl.remove();
        msgListState.count = messages.length;
        setComposerEnabled(!pendingNow, pendingNow ? 'AI 正在回复…' : PLACEHOLDER_DEFAULT);
        spaceEl.scrollTop = spaceEl.scrollHeight;
        return; // 快速路径完成
      } catch (e) {
        msgListState.moduleId = null; // 任何意外：作废增量状态，走全量兜底
      }
    }
    msgListState.moduleId = null;

    spaceEl.innerHTML = '';

    if (!modules.length) {
      // 无模块：空状态 + 一键按流程图初始化 + 禁用输入
      var emptyBox = emptyState(EMPTY_NO_MODULE_TITLE, EMPTY_NO_MODULE_HINT);
      emptyBox.appendChild(flowInitButton());
      spaceEl.appendChild(emptyBox);
      setComposerEnabled(false, PLACEHOLDER_NO_MODULE);
    } else if (!active) {
      // 理论上不可达（modules 非空必有兜底），保底走同一分支
      spaceEl.appendChild(emptyState(EMPTY_NO_MODULE_TITLE, EMPTY_NO_MODULE_HINT));
      setComposerEnabled(false, PLACEHOLDER_NO_MODULE);
    } else {
      messageless = messages.length === 0;

      var header = el('div', 'module-header');
      header.appendChild(el('div', 'module-header-title', active.name));
      header.appendChild(el('div', 'module-header-meta',
        '依赖：' + depLabel(modules, active) + ' · 消息 ' + messages.length + ' 条'));
      spaceEl.appendChild(header);

      // 先状态条（动作优先：提交审核 / 确定通过 一眼可见），再任务说明卡（"这个模块要做什么"）
      spaceEl.appendChild(buildStatusBar(active, modules));
      var specCard = buildSpecCard(active);
      if (specCard) spaceEl.appendChild(specCard);

      var list = el('div', 'msg-list');
      if (!messages.length) {
        list.appendChild(emptyState(active.name,
          '这是「' + active.name + '」的独立空间，在下方输入内容开始'));
      } else {
        for (var i = 0; i < messages.length; i++) list.appendChild(buildMessage(messages[i]));
      }
      spaceEl.appendChild(list);

      if (pendingModules[active.id]) {
        spaceEl.appendChild(el('div', 'ai-pending', 'AI 正在思考…'));
      }

      // 有明确选中的模块才允许输入；兜底渲染（activeModuleId 缺失）时保持禁用
      if (fallback) {
        setComposerEnabled(false, PLACEHOLDER_NO_ACTIVE);
      } else {
        setComposerEnabled(!pendingModules[active.id], pendingModules[active.id] ? 'AI 正在回复…' : PLACEHOLDER_DEFAULT);
      }
    }

    // 滚动位置：有消息滚到底部；没有消息则停在顶部，保证「本模块要做什么」说明卡与审核状态条
    // 一进入模块就能看到（否则说明卡会被滚出视野）。
    // 记录本轮全量渲染结果，供下一次增量快速路径比对
    msgListState = {
      moduleId: (active && !fallback) ? active.id : null,
      count: (active && !fallback) ? messages.length : -1,
      firstId: (active && messages.length) ? messages[0].id : null,
      status: (active && !fallback) ? (active.status || 'todo') : null,
      pending: (active && !fallback) ? !!pendingModules[active.id] : false
    };
    if (messageless) spaceEl.scrollTop = 0;
    else spaceEl.scrollTop = spaceEl.scrollHeight;
  }

  // ------------------------------------------------------------------ 发送

  /** 发送：取输入框文本 -> Store.appendMessage(activeModuleId, text, 'user')；失败不动输入框 */
  function send() {
    if (!inputEl) inputEl = document.getElementById('composer-input');
    if (!inputEl) return;
    var id = activeModuleId();
    if (!id) return;                                    // 无选中模块 / 模块不存在 -> 忽略
    var raw = inputEl.value;
    if (String(raw).trim().length > MAX_INPUT_CHARS) {  // 超长拦截（Store 同样会拒绝，这里提前给提示）
      if (root.alert) root.alert('单条记录最长 ' + MAX_INPUT_CHARS + ' 字，请拆分后再发送。');
      return;
    }
    var msg = getStore().appendMessage(id, raw, 'user');
    if (!msg) return;                                   // 空文本被 Store 拒绝 -> 保留原输入
    inputEl.value = '';
    autoGrow(inputEl);
    render();                                           // 自渲染兜底（app.js 订阅后也会再渲染一次）
    requestReply(id);
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
