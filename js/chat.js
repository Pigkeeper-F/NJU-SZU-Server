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
  var msgListState = { moduleId: null, count: -1, firstId: null, status: null, pending: false, docSig: null };
  var MAX_INPUT_CHARS = (root.Store && root.Store.LIMITS && root.Store.LIMITS.MAX_MESSAGE_CHARS) || 20000; // 加载期与 Store 同步
  var MAX_DOC_CHARS = (root.Store && root.Store.LIMITS && root.Store.LIMITS.MAX_DOC_CHARS) || 20000;      // 环节文档上限，与 Store 同步

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
    if (['download-data', 'clean-data', 'literature-mining'].indexOf(module.type) >= 0) return '并列准备 → 模型调整与计算';
    if (module.type === 'calculation') return '下载数据 / 数据清洗 / 文献挖掘按需汇入';
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
    var recent = (mod.messages || []).filter(function (message) {
      return message.role === 'user' || message.role === 'assistant';
    }).slice(-25).map(function (message) {
      return { role: message.role, text: message.text };
    });
    var executionContext = root.LiteratureUI && root.LiteratureUI.context(moduleId);
    if (executionContext) recent.unshift({ role: 'user', text: executionContext });
    var rules = root.TaskManager && root.TaskManager.confirmedRules();
    if (!rules) return recent;
    var chunks = [];
    for (var offset = 0; offset < rules.length; offset += 3400) {
      chunks.push({ role: 'user', text: '以下是研究者确认的执行规则（第 ' + (chunks.length + 1) + ' 段），仅按规则处理；规则未覆盖的判断先询问：\n' + rules.slice(offset, offset + 3400) });
    }
    return chunks.concat(recent);
  }

  /** 读取本机保存的模型设置（左下角齿轮，模型分组 v2）；没有有效配置返回 null */
  function readLlmSettings() {
    // 【模型分组 · 2026-10-15】解析逻辑收敛到 Store.llmSettings（v1 旧形状由 normalize 自动迁移）
    var api = root.Store && root.Store.llmSettings;
    if (!api) return null;
    try { return api.resolve(api.read()); } catch (error) { return null; }
  }

  /** 模块 spec 归一化（与 composeBody 保持一致的四个字段） */
  function specOf(mod) {
    var spec = (mod && mod.spec) ? mod.spec : {};
    return {
      goal: spec.goal || '',
      todo: Array.isArray(spec.todo) ? spec.todo : [],
      output: spec.output || '',
      acceptance: spec.acceptance || ''
    };
  }

  /**
   * 对话环节上下文（第二批）：本模块 {name, spec} + 沿 dependsOn 链向上回溯、收集所有上游模块中
   * doc.status==='approved' 的 {name, doc: content 截 400 字}。无上游或没有 approved 文档则 upstream=[]。
   * dependsOn 链理论无环，仍加 visited 保护避免脏数据成环时死循环。
   */
  function moduleContextFor(moduleId) {
    var Store = getStore();
    var state = Store ? Store.getState() : null;
    var modules = (state && state.modules) ? state.modules : [];
    var mod = findModule(modules, moduleId);
    if (!mod) return { name: '', spec: specOf(null), upstream: [], params: {} };

    var upstream = [];
    var visited = {};
    var queue = Store.getUpstreamModules(mod.id);
    while (queue.length) {
      var up = queue.shift();
      if (visited[up.id]) continue;
      visited[up.id] = true;
      var rules = root.TaskManager && root.TaskManager.rulesForModule(up.id);
      var approvedText = rules && rules.text || (up.doc && up.doc.status === 'approved' && up.doc.content);
      if (approvedText) {
        upstream.push({ name: up.name, doc: approvedText.slice(0, 400) });
      }
      queue = queue.concat(Store.getUpstreamModules(up.id));
    }
    return { name: mod.name, spec: specOf(mod), upstream: upstream, params: (mod.params && typeof mod.params === 'object') ? mod.params : {} };
  }

  function requestReply(moduleId) {
    var module = findModule(getStore().getState().modules, moduleId);
    var credential = root.ApiKeys && typeof root.ApiKeys.getActiveCredential === 'function'
      ? root.ApiKeys.getActiveCredential()
      : null;
    pendingModules[moduleId] = true;
    render();
    if (root.CodexUI && root.CodexUI.useCodex(module)) {
      return root.CodexUI.reply(module, messagesFor(moduleId)).catch(function (error) {
        getStore().appendMessage(moduleId, 'Codex 请求失败：' + error.message, 'system');
      }).finally(function () { delete pendingModules[moduleId]; render(); });
    }
    return fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messagesFor(moduleId),
        credential: credential,
        settings: readLlmSettings(),
        module: Object.assign(moduleContextFor(moduleId), { type: module.type, step: module.step || null, mode: module.mode || null })
      })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var failure = new Error(data.error || 'AI 服务请求失败');
          failure.config = (data && data.config) ? data.config : null;
          throw failure;
        }
        if (!data || typeof data.text !== 'string') throw new Error('AI 服务返回了无效响应');
        return data.text;
      });
    }).then(function (text) {
      getStore().appendMessage(moduleId, text, 'assistant');
    }).catch(function (error) {
      var detail = (error && error.message) ? error.message : '未知错误';
      // 失败时把「当前生效的是哪份配置」一并说清——最常见的原因是浏览器里残留的
      // 「添加 API」旧凭证盖住了设置里的模型分组，光看报错是猜不出来的。
      var activeCfg = (error && error.config) ? error.config : null;
      if (activeCfg) {
        var sourceText = {
          'browser-credential': '浏览器「添加 API」里的凭证',
          'browser-settings': '网页设置里的模型分组',
          'server-env': '服务端 .env'
        }[activeCfg.source] || activeCfg.source;
        detail += '（当前配置：' + (activeCfg.baseUrl || '-') + ' | ' + (activeCfg.model || '-')
          + ' | 来源：' + sourceText + '）';
      }
      getStore().appendMessage(moduleId, 'AI 回复失败：' + detail, 'system');
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
    // 【文章撰写 · 2026-10-20】目标期刊：本环节开始时手填，存进 module.params，
    // 随对话上下文与执行参数（params.json）传到 AI 与执行脚本。
    if (mod.type === 'writing') {
      var params = (mod.params && typeof mod.params === 'object') ? mod.params : {};
      var field = el('label', 'spec-row spec-field');
      field.appendChild(el('div', 'spec-label', '目标期刊'));
      var input = el('input', 'spec-input');
      input.type = 'text';
      input.placeholder = 'AAAI（默认）；也可填 NeurIPS、ICML 或其它刊名（留空则按通用结构起草并标注未按期刊约束）';
      input.value = params.journal || '';
      input.addEventListener('change', function () {
        var Store = getStore();
        if (Store && Store.setModuleParam) Store.setModuleParam(mod.id, 'journal', input.value);
      });
      field.appendChild(input);
      card.appendChild(field);
    }
    return card;
  }

  /**
   * 【文献调研 · 2026-10-20】环节①的调研面板：一个紧凑区块——主题、检索式、一个按钮。
   * 流程：检索（/api/literature/search）→ 轮询作业 → 要点抽取与空白归纳（/api/literature/research）。
   * 产物落在检索作业目录的 research/ 下（notes.csv / synthesis.md / gaps.md），可从作业面板下载。
   */
  /**
   * 调研面板的状态条：阶段文案 + 已等待秒数 + 取消按钮。
   * 计时每秒局部更新（只改这段文字），不整页重绘——重绘会打断主人正在输入的内容。
   */
  var researchTimer = null;

  /** 当前生效的模型（脱敏）：给主人看"到底在用哪个通道、为什么慢" */
  function modelLabel(config) {
    if (!config) return '';
    var source = {
      'browser-credential': '浏览器「添加 API」',
      'browser-settings': '网页设置',
      'server-env': '服务端 .env'
    }[config.source] || config.source;
    return (config.model || '?') + ' · ' + source;
  }

  /**
   * 【调试台 · 2026-10-20】前端错误上报：JS 异常与未处理的 Promise 拒绝
   * 送到服务端的调试缓冲，调试页能直接看到（不必开 DevTools 手工复制）。
   * 上报失败绝不影响主流程。
   */
  function reportClientError(where, message, stack) {
    try {
      fetch('/api/debug/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
        body: JSON.stringify({ where: where, message: message, stack: stack || '' })
      }).catch(function () { /* 上报失败忽略 */ });
    } catch (error) { /* 忽略 */ }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', function (event) {
      reportClientError('window.onerror', event && event.message, event && event.error && event.error.stack);
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      reportClientError('unhandledrejection', (reason && reason.message) || String(reason), reason && reason.stack);
    });
  }

  function researchStatusText(state) {
    var phase = state.phase || '处理中';
    var sec = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
    return phase + '… 已等待 ' + sec + ' 秒（模型通道慢时可能需要 1–4 分钟）';
  }

  function buildResearchStatusBar(mod, state) {
    if (!state.busy && !state.planBusy && !state.screeningBusy) return null;
    var bar = el('div', 'research-statusbar');
    bar.appendChild(el('span', 'research-dot'));
    var text = el('span', 'research-statusbar-text', researchStatusText(state));
    text.id = 'research-status-text-' + mod.id;
    bar.appendChild(text);
    var cancel = el('button', 'quiet-button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { cancelResearch(mod); });
    bar.appendChild(cancel);
    return bar;
  }

  function startResearchTimer(mod) {
    stopResearchTimer();
    researchTimer = setInterval(function () {
      var node = document.getElementById('research-status-text-' + mod.id);
      var st = uiOf(mod.id).research;
      if (!node || !st) { stopResearchTimer(); return; }
      node.textContent = researchStatusText(st);
    }, 1000);
  }

  function stopResearchTimer() {
    if (researchTimer) { clearInterval(researchTimer); researchTimer = null; }
  }

  function cancelResearch(mod) {
    var st = uiOf(mod.id).research;
    if (st && st.busy && st.jobId) {
      // 只取消轮询不会停掉服务端作业；正式检索可能翻很多页，必须显式取消。
      researchPost('/api/literature/cancel?id=' + encodeURIComponent(st.jobId), {}).catch(function () { /* 作业已结束或已取消 */ });
    }
    if (st && st.abort) { try { st.abort.abort(); } catch (error) { /* 忽略 */ } }
    stopResearchTimer();
    if (st) {
      st.busy = false; st.planBusy = false; st.screeningBusy = false;
      st.phase = ''; st.startedAt = 0; st.message = '已取消';
    }
    render();
  }

  // 【多源检索 · 2026-10-22】来源清单从服务端注册表取（不在前端写死），缓存一次。
  var literatureSourceCache = null;
  var literatureSourceLoading = false;
  function loadLiteratureSources(done) {
    if (literatureSourceCache) { done(literatureSourceCache); return; }
    if (literatureSourceLoading) return;
    literatureSourceLoading = true;
    researchGet('/api/literature/sources').then(function (data) {
      literatureSourceCache = (data && Array.isArray(data.sources)) ? data.sources : [];
      literatureSourceLoading = false;
      done(literatureSourceCache);
    }).catch(function () {
      literatureSourceCache = [{ key: 'google-scholar', label: 'Google Scholar', access: 'browser' }];
      literatureSourceLoading = false;
      done(literatureSourceCache);
    });
  }
  function researchSourceLabel(key) {
    var list = literatureSourceCache || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === key) return list[i].label || key;
    }
    return key;
  }

  function buildResearchPanel(mod) {
    if (!mod || mod.type !== 'literature-research') return null;
    var state = uiOf(mod.id).research || (uiOf(mod.id).research = {
      topic: '', query: '', busy: false, message: '', result: null,
      plan: null, planBusy: false, planMessage: '',
      candidates: null, keep: null, screeningBusy: false, jobId: '',
      phase: '', startedAt: 0, abort: null, model: '',
      importBusy: false, importMessage: '',
      sources: ['google-scholar'], perSource: {}, sourceResults: null,
      searchMode: 'test', stopMode: 'count', perSourceLimit: 10
    });
    if (!Array.isArray(state.sources) || !state.sources.length) state.sources = ['google-scholar'];
    if (!state.perSource || typeof state.perSource !== 'object') state.perSource = {};
    if (state.searchMode !== 'formal') { state.searchMode = 'test'; state.stopMode = 'count'; state.perSourceLimit = 10; }
    if (!literatureSourceCache) {
      loadLiteratureSources(function (list) { if (list && list.length) render(); });
    }
    // 刷新后恢复：作业 id 记在模块参数上，候选清单按它重新拉回（否则初筛界面会丢）
    if (!state.jobId && mod.params && typeof mod.params.researchJobId === 'string') {
      state.jobId = mod.params.researchJobId;
    }
    if (!state.candidates && state.jobId) {
      researchGet('/api/literature/candidates?id=' + encodeURIComponent(state.jobId)).then(function (data) {
        state.candidates = (data && data.candidates) || [];
        state.sourceResults = (data && Array.isArray(data.sources)) ? data.sources : (state.sourceResults || []);
        state.keep = state.keep || state.candidates.map(function (c) { return c.id; });
        render();
      }).catch(function () { /* 拉不到就留空，用户可重新检索 */ });
    }
    var box = el('div', 'research-panel');

    // 状态条放在面板最上面：长等待时必须一眼看得见（免费通道单次调用可能 1–4 分钟）
    var statusBar = buildResearchStatusBar(mod, state);
    if (statusBar) box.appendChild(statusBar);

    var topicRow = el('label', 'research-field');
    topicRow.appendChild(el('span', 'research-label', '想法'));
    var topicInput = el('input', 'research-input');
    topicInput.type = 'text';
    topicInput.placeholder = '研究想法（哪怕只有一句话）';
    topicInput.value = state.topic || '';
    topicInput.addEventListener('input', function () { state.topic = topicInput.value; });
    topicRow.appendChild(topicInput);
    // 冷启动：只有模糊想法时，让 AI 先出候选检索式
    var planBtn = el('button', 'quiet-button', state.planBusy ? '生成中…' : '生成检索式');
    planBtn.type = 'button';
    planBtn.disabled = state.planBusy === true;
    planBtn.addEventListener('click', function () {
      state.topic = topicInput.value.trim();
      runResearchPlan(mod);
      render();
    });
    topicRow.appendChild(planBtn);
    box.appendChild(topicRow);

    // 【多源检索 · 2026-10-22】来源多选：开放 API 源（PubMed/OpenAlex 等）免验证码，
    // 与 Scholar 同批合并，重复条目按 DOI/标题去掉。
    var sourceOptions = (literatureSourceCache && literatureSourceCache.length)
      ? literatureSourceCache
      : [{ key: 'google-scholar', label: 'Google Scholar', access: 'browser' }];
    var sourceRow = el('div', 'research-sources');
    sourceRow.appendChild(el('span', 'research-label', '检索来源'));
    for (var si = 0; si < sourceOptions.length; si++) {
      (function (source) {
        var wrap = el('label', 'research-source');
        var cb = el('input', 'research-check');
        cb.type = 'checkbox';
        cb.checked = state.sources.indexOf(source.key) >= 0;
        cb.addEventListener('change', function () {
          var next = state.sources.slice();
          var at = next.indexOf(source.key);
          if (cb.checked && at < 0) next.push(source.key);
          if (!cb.checked && at >= 0) next.splice(at, 1);
          if (!next.length) {
            cb.checked = true;
            state.message = '至少保留一个检索来源';
            render();
            return;
          }
          state.sources = next;
          state.message = '';
          render();
        });
        wrap.appendChild(cb);
        wrap.appendChild(el('span', 'research-source-label', source.label || source.key));
        if (source.access === 'api') wrap.appendChild(el('span', 'research-source-tag', '免验证'));
        sourceRow.appendChild(wrap);
      })(sourceOptions[si]);
    }
    box.appendChild(sourceRow);

    var multiSource = state.sources.length > 1 || state.sources[0] !== 'google-scholar';
    var queryRow = el('label', 'research-field');
    queryRow.appendChild(el('span', 'research-label', multiSource ? '通用检索式' : '检索式'));
    var queryInput = el('input', 'research-input');
    queryInput.type = 'text';
    queryInput.placeholder = multiSource
      ? '未单列检索式的来源用它，如 "soil organic carbon" fertilization'
      : 'Google Scholar 检索式，如 ("long-term fertilization") "soil organic carbon"';
    queryInput.value = state.query || '';
    queryInput.addEventListener('input', function () { state.query = queryInput.value; });
    queryRow.appendChild(queryInput);
    box.appendChild(queryRow);

    // 多源时逐源显示检索式：不同来源语法不通用（PubMed 用字段标签、OpenAlex 用自然语言）。
    if (multiSource) {
      var perSourceBox = el('div', 'research-per-source');
      for (var psi = 0; psi < state.sources.length; psi++) {
        (function (key) {
          var row = el('label', 'research-field');
          row.appendChild(el('span', 'research-label', researchSourceLabel(key) + ' 检索式'));
          var input = el('input', 'research-input');
          input.type = 'text';
          input.placeholder = key === 'google-scholar' ? '同通用检索式' : '留空则用通用检索式';
          input.value = state.perSource[key] || '';
          input.addEventListener('input', function () { state.perSource[key] = input.value; });
          row.appendChild(input);
          perSourceBox.appendChild(row);
        })(state.sources[psi]);
      }
      box.appendChild(perSourceBox);
    }

    // 检索规模：测试运行只取 10 条/源；正式检索可放大候选数或翻到末页。
    var modeRow = el('label', 'research-field');
    modeRow.appendChild(el('span', 'research-label', '规模'));
    var modeSelect = el('select', 'research-input research-select');
    modeSelect.setAttribute('aria-label', '检索规模');
    [['test', '测试运行（每来源最多 10 条）'],
      ['count:50', '正式检索（每来源最多 50 条）'],
      ['count:100', '正式检索（每来源最多 100 条）'],
      ['end', '正式检索（到可访问末页）']].forEach(function (pair) {
      var option = el('option', null, pair[1]);
      option.value = pair[0];
      modeSelect.appendChild(option);
    });
    modeSelect.value = state.searchMode === 'formal'
      ? (state.stopMode === 'end' ? 'end' : 'count:' + (state.perSourceLimit || 100))
      : 'test';
    modeSelect.disabled = state.busy === true;
    modeSelect.addEventListener('change', function () {
      var value = modeSelect.value;
      if (value === 'end') {
        state.searchMode = 'formal'; state.stopMode = 'end'; state.perSourceLimit = null;
      } else if (value.indexOf('count:') === 0) {
        state.searchMode = 'formal'; state.stopMode = 'count'; state.perSourceLimit = Number(value.slice(6)) || 100;
      } else {
        state.searchMode = 'test'; state.stopMode = 'count'; state.perSourceLimit = 10;
      }
      render();
    });
    modeRow.appendChild(modeSelect);
    box.appendChild(modeRow);
    if (state.searchMode === 'formal') {
      box.appendChild(el('div', 'research-status',
        state.stopMode === 'end'
          ? '正式检索会逐页翻到来源可访问末页，可能较久；遇到登录/验证/权限会暂停并保留已下载候选。'
          : '正式检索按每来源 ' + state.perSourceLimit + ' 条上限分页获取；遇到登录/验证/权限会暂停并保留已下载候选。'));
    }

    // 候选检索式（冷启动结果）：点一条即填入检索式框
    if (state.plan && state.plan.queries && state.plan.queries.length) {
      var planBox = el('div', 'research-plans');
      for (var pi = 0; pi < state.plan.queries.length; pi++) {
        (function (item) {
          var row = el('div', 'research-plan');
          var use = el('button', 'quiet-button', '用这条');
          use.type = 'button';
          use.addEventListener('click', function () {
            state.query = item.query;
            render();
          });
          row.appendChild(el('span', 'research-plan-query', item.query));
          if (item.rationale) row.appendChild(el('span', 'research-plan-why', item.rationale));
          row.appendChild(use);
          planBox.appendChild(row);
        })(state.plan.queries[pi]);
      }
      box.appendChild(planBox);
    }

    // 【多源检索 · 2026-10-22】按来源分化的检索计划：每个来源一条，按该源语法写。
    var planPerSource = (state.plan && Array.isArray(state.plan.perSource)) ? state.plan.perSource : [];
    var selectedPlans = planPerSource.filter(function (item) {
      return item && state.sources.indexOf(item.source) >= 0;
    });
    if (selectedPlans.length) {
      var psBox = el('div', 'research-plans');
      psBox.appendChild(el('div', 'research-plan-title', '按来源的检索式（点「用这条」填入该源）'));
      for (var ppi = 0; ppi < selectedPlans.length; ppi++) {
        (function (item) {
          var row = el('div', 'research-plan');
          row.appendChild(el('span', 'research-plan-source', researchSourceLabel(item.source)));
          row.appendChild(el('span', 'research-plan-query', item.query));
          if (item.rationale) row.appendChild(el('span', 'research-plan-why', item.rationale));
          var use = el('button', 'quiet-button', '用这条');
          use.type = 'button';
          use.addEventListener('click', function () {
            state.perSource[item.source] = item.query;
            if (item.source === 'google-scholar') state.query = item.query;
            render();
          });
          row.appendChild(use);
          psBox.appendChild(row);
        })(selectedPlans[ppi]);
      }
      box.appendChild(psBox);
    }
    if (state.planMessage) box.appendChild(el('div', 'research-status', state.planMessage));
    // 当前用的哪个模型通道（慢的时候主人一眼能看出是不是走了慢通道）
    if (state.model) box.appendChild(el('div', 'research-model', '当前模型：' + state.model));

    var actions = el('div', 'research-actions');
    var runBtn = el('button', 'status-btn status-btn-primary', state.busy ? '调研中…' : '检索');
    runBtn.type = 'button';
    runBtn.disabled = state.busy === true;
    runBtn.addEventListener('click', function () {
      state.topic = topicInput.value.trim();
      state.query = queryInput.value.trim();
      runResearch(mod);
      render();
    });
    actions.appendChild(runBtn);
    if (state.message) actions.appendChild(el('span', 'research-status', state.message));
    box.appendChild(actions);

    // 【多源检索 · 2026-10-22】逐源命中/失败：混合检索时一眼看出是哪个源没拿到。
    if (state.sourceResults && state.sourceResults.length) {
      var srcBox = el('div', 'research-source-results');
      for (var sri = 0; sri < state.sourceResults.length; sri++) {
        (function (meta) {
          var status = String(meta.status || '');
          var failed = status !== 'ok' && status !== 'no_results';
          var text = (meta.label || meta.source_key || '来源') + '：'
            + (failed ? ('失败 — ' + (meta.error || status || '未知原因')) : (Number(meta.count || 0) + ' 条'));
          srcBox.appendChild(el('span', 'research-source-result' + (failed ? ' research-source-result-fail' : ''), text));
        })(state.sourceResults[sri]);
      }
      box.appendChild(srcBox);
    }

    // 人工初筛：检索完成后列出候选，勾掉不相关的再抽要点
    if (state.candidates && state.candidates.length) {
      var list = el('div', 'research-screening');
      list.appendChild(el('div', 'research-screening-title',
        '初筛：勾掉不要读的（' + state.candidates.length + ' 篇候选）'));
      for (var ci = 0; ci < state.candidates.length; ci++) {
        (function (item) {
          var row = el('label', 'research-screen-row');
          var cb = el('input', 'research-check');
          cb.type = 'checkbox';
          cb.checked = state.keep ? state.keep.indexOf(item.id) >= 0 : true;
          cb.addEventListener('change', function () {
            var keep = state.keep || state.candidates.map(function (c) { return c.id; });
            var at = keep.indexOf(item.id);
            if (cb.checked && at < 0) keep.push(item.id);
            if (!cb.checked && at >= 0) keep.splice(at, 1);
            state.keep = keep;
          });
          row.appendChild(cb);
          row.appendChild(el('span', 'research-screen-title', item.title || '(无标题)'));
          var meta = [item.authors, item.year, item.venue].filter(Boolean).join(' · ');
          if (meta) row.appendChild(el('span', 'research-screen-meta', meta));
          list.appendChild(row);
        })(state.candidates[ci]);
      }
      var screenActions = el('div', 'research-actions');
      var screenBtn = el('button', 'status-btn status-btn-primary', state.screeningBusy ? '抽取中…' : '确认初筛并生成要点');
      screenBtn.type = 'button';
      screenBtn.disabled = state.screeningBusy === true;
      screenBtn.addEventListener('click', function () {
        runResearchScreen(mod);
        render();
      });
      screenActions.appendChild(screenBtn);
      list.appendChild(screenActions);
      box.appendChild(list);
    }

    // 【文献清单导入 · 2026-10-21】知网/万方/WoS/Scopus 检索不到（登录态+验证码+订阅），
    // 唯一诚实的路径是：用自己账号在源站检索 → 导出 RIS/BibTeX/CSV → 在这里导入候选池。
    var importRow = el('div', 'research-import');
    var importLabel = el('span', 'research-import-label', '检索不到的源（知网/万方等）：');
    importRow.appendChild(importLabel);
    var srcSelect = el('select', 'research-import-select');
    [['cnki', '知网'], ['wanfang', '万方'], ['web-of-science', 'Web of Science'], ['scopus', 'Scopus']].forEach(function (pair) {
      var opt = el('option', null, pair[1]);
      opt.value = pair[0];
      srcSelect.appendChild(opt);
    });
    importRow.appendChild(srcSelect);
    var fileInput = el('input', 'research-import-file');
    fileInput.type = 'file';
    fileInput.accept = '.ris,.bib,.bibtex,.csv,.txt';
    fileInput.style.display = 'none';
    var importBtn = el('button', 'quiet-button', state.importBusy ? '导入中…' : '导入清单');
    importBtn.type = 'button';
    importBtn.disabled = state.importBusy === true;
    importBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (file) importLiteratureList(mod, file, srcSelect.value);
      fileInput.value = '';
    });
    importRow.appendChild(importBtn);
    importRow.appendChild(fileInput);
    if (state.importMessage) importRow.appendChild(el('span', 'research-status', state.importMessage));
    box.appendChild(importRow);

    if (state.result) {
      var sum = el('div', 'research-summary');
      var meta2 = state.result.meta || {};
      sum.appendChild(el('div', 'research-summary-line',
        '文献 ' + (meta2.candidate_count || 0) + ' 篇（有全文 ' + (meta2.with_fulltext || 0) + ' 篇）'
        + '｜要点 ' + ((state.result.notes || []).length) + ' 条'
        + '｜空白 ' + ((state.result.gaps || []).length) + ' 条'));
      // 产物可直接下载（服务端只放行已登记的 research/* 文件）
      var files = state.result.files || [];
      if (files.length && state.jobId) {
        var links = el('div', 'research-files');
        for (var fi = 0; fi < files.length; fi++) {
          (function (name) {
            var a = el('a', 'research-file-link', name.replace(/^research\//, ''));
            a.href = '/api/literature/download?id=' + encodeURIComponent(state.jobId) + '&name=' + encodeURIComponent(name);
            a.setAttribute('download', '');
            links.appendChild(a);
          })(files[fi]);
        }
        sum.appendChild(links);
      }
      box.appendChild(sum);
    }
    return box;
  }

  function researchPost(url, body, signal) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        return data;
      });
    });
  }

  function researchGet(url) {
    return fetch(url, { headers: { 'X-Workbench': '1' } }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        return data;
      });
    });
  }

  /** 环节① · 冷启动：模糊想法 → 候选检索式（人在几条里挑一条）。 */
  function runResearchPlan(mod) {
    var state = uiOf(mod.id).research;
    if (!state || state.planBusy) return;
    if (!state.topic) {
      state.planMessage = '先写一句你的研究想法';
      render();
      return;
    }
    state.planBusy = true;
    state.phase = '正在拆解想法、生成候选检索式';
    state.startedAt = Date.now();
    state.planMessage = '拆解中…';
    state.abort = new AbortController();
    render();
    startResearchTimer(mod);
    researchPost('/api/literature/research-plan', { idea: state.topic, sources: state.sources, settings: readLlmSettings() || {} }, state.abort.signal)
      .then(function (plan) {
        stopResearchTimer();
        state.planBusy = false;
        state.phase = '';
        state.startedAt = 0;
        state.plan = plan;
        // 模型给的按源检索式直接落到各源输入框；通用检索式只在用户还没填时补上。
        if (plan && Array.isArray(plan.perSource)) {
          for (var i = 0; i < plan.perSource.length; i++) {
            var item = plan.perSource[i];
            if (!item || !item.source || !item.query) continue;
            state.perSource[item.source] = item.query;
            if (item.source === 'google-scholar' && !String(state.query || '').trim()) state.query = item.query;
          }
        }
        if (!String(state.query || '').trim() && plan && plan.queries && plan.queries.length) {
          state.query = plan.queries[0].query;
        }
        state.model = modelLabel(plan && plan.config);
        state.planMessage = plan && plan.dimensions && plan.dimensions.length
          ? ('检索维度：' + plan.dimensions.map(function (d) { return d.name; }).join('、'))
          : '';
        render();
      })
      .catch(function (error) {
        stopResearchTimer();
        state.planBusy = false;
        state.phase = '';
        state.startedAt = 0;
        state.planMessage = (error && error.name === 'AbortError')
          ? '已取消'
          : '拆解失败：' + ((error && error.message) || '未知错误');
        render();
      });
  }

  /**
   * 环节①：检索 → 列出候选 → 人工初筛 → 抽要点与空白。
   * 检索完成后不直接抽取：先让人勾掉不相关的（省模型调用，也更准）。
   */
  function runResearch(mod) {
    var state = uiOf(mod.id).research;
    if (!state || state.busy) return;
    var sources = (Array.isArray(state.sources) && state.sources.length) ? state.sources.slice() : ['google-scholar'];
    var query = String(state.query || '').trim() || String(state.perSource[sources[0]] || '').trim();
    if (!state.topic || !query) {
      state.message = '请先填想法与检索式（检索式可以点「生成检索式」自动生成）';
      render();
      return;
    }
    var sourceQueries = {};
    for (var qi = 0; qi < sources.length; qi++) {
      var custom = String(state.perSource[sources[qi]] || '').trim();
      if (custom) sourceQueries[sources[qi]] = custom;
    }
    state.busy = true;
    state.phase = '正在检索 ' + sources.map(researchSourceLabel).join('、');
    state.startedAt = Date.now();
    state.message = '检索中…';
    state.result = null;
    state.candidates = null;
    state.keep = null;
    state.sourceResults = null;
    state.abort = new AbortController();
    render();
    startResearchTimer(mod);

    var jobId = '';
    var finalJob = null;
    var searchConfig = {
      topic: state.topic, query: query, sources: sources,
      sourceQueries: sourceQueries, limit: 10
    };
    if (state.searchMode === 'formal') {
      searchConfig.searchMode = 'formal';
      searchConfig.stopMode = state.stopMode === 'end' ? 'end' : 'count';
      searchConfig.perSourceLimit = state.stopMode === 'end' ? null : Number(state.perSourceLimit || 100);
    }
    var pollLimitMs = state.searchMode === 'formal'
      ? (state.stopMode === 'end' ? 45 * 60 * 1000 : 20 * 60 * 1000)
      : 4 * 60 * 1000;
    var pollLimitText = state.searchMode === 'formal'
      ? (state.stopMode === 'end' ? '45 分钟' : '20 分钟')
      : '4 分钟';
    researchPost('/api/literature/search', {
      config: searchConfig
    }, state.abort.signal).then(function (started) {
      jobId = started && started.id ? started.id : '';
      if (!jobId) throw new Error('检索作业没有返回标识');
      state.jobId = jobId;
      state.message = '检索中（作业 ' + jobId.slice(0, 8) + '…）…';
      render();
      // 轮询作业状态：检索阶段完成后才进初筛
      var waited = 0;
      function poll() {
        return researchGet('/api/literature/job?id=' + encodeURIComponent(jobId)).then(function (job) {
          waited += 1500;
          if (job.status === 'running' || job.status === 'queued') {
            if (waited > pollLimitMs) throw new Error('检索超时（超过 ' + pollLimitText + '）');
            state.message = '检索中：' + String(job.message || ('作业 ' + jobId.slice(0, 8) + '…'));
            render();
            return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(poll);
          }
          if (job.status === 'failed') throw new Error(job.error || '检索失败');
          finalJob = job;
          return job;
        });
      }
      return poll();
    }).then(function () {
      // 作业 id 记到模块参数上：环节②靠它把调研产物传下去（衔接的关键一环）
      var Store = getStore();
      if (Store && Store.setModuleParam) Store.setModuleParam(mod.id, 'researchJobId', jobId);
      state.jobId = jobId;
      return researchGet('/api/literature/candidates?id=' + encodeURIComponent(jobId));
    }).then(function (data) {
      stopResearchTimer();
      state.busy = false;
      state.phase = '';
      state.startedAt = 0;
      state.candidates = (data && data.candidates) || [];
      state.keep = state.candidates.map(function (c) { return c.id; });
      state.sourceResults = (data && Array.isArray(data.sources)) ? data.sources : [];
      var failed = state.sourceResults.filter(function (meta) {
        var status = String((meta && meta.status) || '');
        return status !== 'ok' && status !== 'no_results';
      });
      var perSource = state.sourceResults.length > 1
        ? '（' + state.sourceResults.map(function (meta) {
          var status = String((meta && meta.status) || '');
          return (meta.label || meta.source_key || '来源') + ' '
            + (status === 'ok' ? (Number(meta.count || 0) + ' 条') : '失败');
        }).join('、') + '）'
        : '';
      state.message = state.candidates.length
        ? ('检索到 ' + state.candidates.length + ' 篇' + perSource + '，请初筛后生成要点')
        : ('检索没有结果——换条检索式或放宽条件'
          + (failed.length ? '（' + failed.map(function (meta) { return (meta.label || meta.source_key) + '：' + (meta.error || meta.status); }).join('；') + '）' : ''));
      if (finalJob && finalJob.status === 'needs_attention') {
        state.message = (state.candidates.length ? ('已保存 ' + state.candidates.length + ' 篇候选') : '尚未保存候选')
          + '；部分来源需要人工登录/验证，可到「文献挖掘」面板继续原任务。';
      }
      render();
    }).catch(function (error) {
      stopResearchTimer();
      state.busy = false;
      state.phase = '';
      state.startedAt = 0;
      state.message = (error && error.name === 'AbortError')
        ? '已取消'
        : '失败：' + ((error && error.message) || '未知错误');
      render();
    });
  }

  /** 环节① · 人工初筛：写 screening.json，再抽要点与研究空白。 */
  function runResearchScreen(mod) {
    var state = uiOf(mod.id).research;
    if (!state || state.screeningBusy || !state.jobId) return;
    var all = (state.candidates || []).map(function (c) { return c.id; });
    var keep = state.keep || all;
    var excluded = all.filter(function (id) { return keep.indexOf(id) < 0; })
      .map(function (id) { return { id: id, reason: '初筛未勾选' }; });
    state.screeningBusy = true;
    state.phase = '正在抽取要点、共识分歧与研究空白';
    state.startedAt = Date.now();
    state.message = '抽取要点与研究空白中…';
    state.abort = new AbortController();
    render();
    startResearchTimer(mod);
    researchPost('/api/literature/research-screen', { jobId: state.jobId, keep: keep, exclude: excluded }, state.abort.signal)
      .then(function () {
        return researchPost('/api/literature/research', { jobId: state.jobId, settings: readLlmSettings() || {} }, state.abort.signal);
      })
      .then(function (result) {
        stopResearchTimer();
        state.screeningBusy = false;
        state.phase = '';
        state.startedAt = 0;
        state.result = result;
        state.model = modelLabel(result && result.config);
        state.message = result && result.ok
          ? ('完成：' + ((result.notes || []).length) + ' 篇要点、' + ((result.gaps || []).length) + ' 条研究空白')
          : ('部分完成：' + ((result && result.error) || '模型返回异常'));
        var Store = getStore();
        if (Store && Store.appendMessage) {
          Store.appendMessage(mod.id, '文献调研产物：' + state.message + '。产物在检索作业 ' + String(state.jobId).slice(0, 8) + ' 的 research/ 目录下。', 'system');
        }
        render();
      })
      .catch(function (error) {
        stopResearchTimer();
        state.screeningBusy = false;
        state.phase = '';
        state.startedAt = 0;
        state.message = (error && error.name === 'AbortError')
          ? '已取消'
          : '失败：' + ((error && error.message) || '未知错误');
        render();
      });
  }

  /**
   * 文献清单导入：把知网/万方/WoS/Scopus 导出的 RIS/BibTeX/CSV 并入当前作业的候选池。
   * 导入的条目与检索来的条目同构，下游阶段零改动。
   */
  function importLiteratureList(mod, file, sourceKey) {
    var state = uiOf(mod.id).research;
    if (!state || state.importBusy) return;
    var jobId = (mod.params && typeof mod.params.researchJobId === 'string') ? mod.params.researchJobId : '';
    if (!jobId) {
      state.importMessage = '还没有检索作业——先跑一次检索，再导入清单';
      render();
      return;
    }
    state.importBusy = true;
    state.importMessage = '读取中…';
    render();
    var reader = new FileReader();
    reader.onload = function () {
      researchPost('/api/literature/import', {
        jobId: jobId,
        source: sourceKey,
        filename: file.name || '',
        content: String(reader.result || '')
      }).then(function (result) {
        state.importBusy = false;
        state.importMessage = '已导入 ' + ((result && result.added) || 0) + ' 条'
          + '（候选池共 ' + ((result && result.total) || 0) + ' 条）';
        // 导入后重置初筛选择：新增条目默认也参与
        state.keep = null;
        state.candidates = null;
        render();
      }).catch(function (error) {
        state.importBusy = false;
        state.importMessage = '导入失败：' + ((error && error.message) || '未知错误');
        render();
      });
    };
    reader.onerror = function () {
      state.importBusy = false;
      state.importMessage = '读取文件失败';
      render();
    };
    reader.readAsText(file, 'utf-8');
  }

  /**
   * 【上游产物汇聚 · 2026-10-20】沿 dependsOn 链向上收集上游模块的产物目录与文献作业 id。
   * 服务端会把这些目录复制进本次执行目录的 upstream/<模块名>/，脚本即可直接读到
   * 上游的图表 / 数据 / 文稿（文章撰写环节靠它拿到上游产物）。
   */
  function collectUpstreamArtifacts(moduleId) {
    var dirs = [];
    var jobs = [];
    var Store = getStore();
    var state = Store ? Store.getState() : null;
    var modules = (state && state.modules) ? state.modules : [];
    var self = findModule(modules, moduleId);
    var visited = {};
    var cursor = self ? self.dependsOn : null;
    while (cursor && !visited[cursor]) {
      visited[cursor] = true;
      var up = findModule(modules, cursor);
      if (!up) break;
      if (up.run && typeof up.run.dir === 'string' && up.run.dir) {
        dirs.push({ name: up.name || '上游模块', dir: up.run.dir });
      }
      var jobId = '';
      if (root.CodexUI && typeof root.CodexUI.literatureJobId === 'function') {
        try { jobId = root.CodexUI.literatureJobId(up.id) || ''; } catch (error) { jobId = ''; }
      }
      if (jobId) jobs.push(jobId);
      // 环节①的调研作业 id 记在模块参数上（researchJobId）——环节②靠它拿到上游的
      // 空白清单与文献要点，这是「①→②」真正接上的那一环。
      if (up.params && typeof up.params === 'object' && typeof up.params.researchJobId === 'string' && up.params.researchJobId) {
        if (jobs.indexOf(up.params.researchJobId) < 0) jobs.push(up.params.researchJobId);
      }
      cursor = up.dependsOn;
    }
    return { dirs: dirs, jobs: jobs };
  }

  /**
   * 环节② · 科学问题凝练面板：想法 → 候选科学问题 → 人选一条 → 问题说明书。
   * 说明书写进环节文档（走人工审核门），它就是下游③数据获取与④方法选择的输入契约。
   */
  function buildQuestionPanel(mod) {
    if (!mod || mod.type !== 'question-formation') return null;
    var state = uiOf(mod.id).question || (uiOf(mod.id).question = {
      idea: '', busy: false, message: '', candidates: [], chosen: null, spec: null
    });
    var box = el('div', 'research-panel');

    var ideaRow = el('label', 'research-field');
    ideaRow.appendChild(el('span', 'research-label', '想法'));
    var ideaInput = el('input', 'research-input');
    ideaInput.type = 'text';
    ideaInput.placeholder = '你想研究什么（一句话即可）';
    ideaInput.value = state.idea || '';
    ideaInput.addEventListener('input', function () { state.idea = ideaInput.value; });
    ideaRow.appendChild(ideaInput);
    var genBtn = el('button', 'status-btn status-btn-primary', state.busy ? '生成中…' : '生成候选问题');
    genBtn.type = 'button';
    genBtn.disabled = state.busy === true;
    genBtn.addEventListener('click', function () {
      state.idea = ideaInput.value.trim();
      runQuestionCandidates(mod);
      render();
    });
    ideaRow.appendChild(genBtn);
    box.appendChild(ideaRow);

    if (state.message) box.appendChild(el('div', 'research-status', state.message));

    if (state.candidates && state.candidates.length) {
      var list = el('div', 'question-list');
      list.appendChild(el('div', 'research-screening-title', '候选科学问题（' + state.candidates.length + ' 条）'));
      for (var ci = 0; ci < state.candidates.length; ci++) {
        (function (item) {
          var card = el('div', 'question-card');
          card.appendChild(el('div', 'question-statement', item.statement));
          if (item.hypothesis) card.appendChild(el('div', 'question-line', '假设：' + item.hypothesis));
          if (item.variables && item.variables.length) {
            card.appendChild(el('div', 'question-line', '变量：' + item.variables.join('、')));
          }
          if (item.boundary) card.appendChild(el('div', 'question-line', '边界：' + item.boundary));
          if (item.gapRefs && item.gapRefs.length) {
            card.appendChild(el('div', 'question-line', '对应空白：' + item.gapRefs.join('；')));
          }
          if (item.basis && item.basis.length) {
            var basis = item.basis.map(function (b) { return b.id + '：' + b.what; }).join('；');
            card.appendChild(el('div', 'question-line', '文献依据：' + basis));
          }
          if (item.feasibility) card.appendChild(el('div', 'question-line', '可行性：' + item.feasibility));
          var take = el('button', 'quiet-button', '采用这条');
          take.type = 'button';
          take.addEventListener('click', function () {
            runQuestionSpecification(mod, item);
            render();
          });
          card.appendChild(take);
          list.appendChild(card);
        })(state.candidates[ci]);
      }
      box.appendChild(list);
    }

    if (state.spec) {
      var specBox = el('div', 'question-spec');
      specBox.appendChild(el('div', 'question-spec-title', '问题说明书'));
      var pre = el('pre', 'question-spec-text', state.spec);
      specBox.appendChild(pre);
      box.appendChild(specBox);
    }
    return box;
  }

  /** 环节② · 第一步：由上游空白与文献要点生成候选科学问题。 */
  function runQuestionCandidates(mod) {
    var state = uiOf(mod.id).question;
    if (!state || state.busy) return;
    state.busy = true;
    state.message = '凝练中（读取上游调研产物）…';
    render();
    researchPost('/api/research/questions', {
      action: 'candidates',
      idea: state.idea,
      upstreamJobIds: collectUpstreamArtifacts(mod.id).jobs,
      settings: readLlmSettings() || {}
    }).then(function (result) {
      state.busy = false;
      state.candidates = (result && result.candidates) || [];
      state.message = state.candidates.length
        ? ('给出 ' + state.candidates.length + ' 个候选问题，选一条')
        : '没有可支撑的候选问题——可能是文献材料不足，或这个方向已被充分研究';
      render();
    }).catch(function (error) {
      state.busy = false;
      state.message = '失败：' + ((error && error.message) || '未知错误');
      render();
    });
  }

  /** 环节② · 第二步：把选定的问题展开成说明书，并写进环节文档（人工审核门）。 */
  function runQuestionSpecification(mod, candidate) {
    var state = uiOf(mod.id).question;
    if (!state || state.busy) return;
    state.busy = true;
    state.chosen = candidate;
    state.message = '展开问题说明书…';
    render();
    researchPost('/api/research/questions', {
      action: 'specify',
      idea: state.idea,
      choice: candidate,
      upstreamJobIds: collectUpstreamArtifacts(mod.id).jobs,
      settings: readLlmSettings() || {}
    }).then(function (result) {
      state.busy = false;
      state.spec = result && result.markdown ? result.markdown : '';
      state.message = '说明书已生成';
      var Store = getStore();
      // 写进环节文档：它要经人工审核才生效，审核通过后就是下游的输入契约
      if (Store && Store.saveDoc && state.spec) {
        try {
          Store.saveDoc(mod.id, state.spec);
        } catch (error) { /* 文档保存失败不阻断，消息里仍会说明 */ }
      }
      if (Store && Store.appendMessage) {
        Store.appendMessage(mod.id,
          '科学问题说明书已生成' + (Store.getState && Store.getState().modules.find(function (m) { return m.id === mod.id; }) && Store.getState().modules.find(function (m) { return m.id === mod.id; }).doc
            ? '并已写入环节文档（待人工审核）' : '（未能写入环节文档）') + '。',
          'system');
      }
      render();
    }).catch(function (error) {
      state.busy = false;
      state.message = '失败：' + ((error && error.message) || '未知错误');
      render();
    });
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
    // 【2026-10-21】文档批准 ≠ 环节通过。两处都叫"审核通过"会让人以为点完文档就该跳模块，
    // 所以这里在文档已批准时把路径写清楚：先提交本环节，再确认通过才会进入下一模块。
    var downloadPending = mod.type === 'download-data' && (!mod.run || mod.run.status !== 'confirmed');
    var hint = STATUS_HINT[st] || '';
    var docApproved = !!(mod.doc && mod.doc.status === 'approved');
    if (!downloadPending && docApproved && (st === 'todo' || st === 'doing')) {
      hint = '文档已批准（验收标准已生效）→ 点「完成并提交审核」提交本环节 → 再点「通过本环节」进入下一模块';
    }
    bar.appendChild(el('span', 'status-hint', downloadPending ? '审核下载方案 → 平台自动获取 → 核查成果后交接' : hint));
    if (mod.type === 'manual-review') bar.appendChild(el('span', 'status-hint', '这是成果审核：由你查看结果和核查报告，在对话中记录审核对象、通过或退回理由，再提交并选择通过或打回。退回上游修改需手动切换对应模块。'));

    var actions = el('div', 'status-actions');
    if (downloadPending) {
      // Actual download and handoff provide this module's completion gate.
    } else if (st === 'todo' || st === 'doing') {
      actions.appendChild(actionButton('完成并提交审核', 'primary', function () {
        getStore().submitModule(mod.id);
      }));
    } else if (st === 'review') {
      actions.appendChild(actionButton('通过本环节 → 下一模块', 'primary', function () {
        getStore().approveModule(mod.id);      // 内部已把选中切到下一模块
      }));
      actions.appendChild(actionButton('打回重做', 'ghost', function () {
        getStore().rejectModule(mod.id, '需要补充后再提交');
      }));
    } else if (st === 'approved') {
      var next = modules.filter(function (candidate) {
        return getStore().getUpstreamModules(candidate.id).some(function (up) { return up.id === mod.id; });
      })[0] || null;
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

  // ------------------------------------ 环节文档卡（标准与验收的契约）· 生成/编辑/审核/执行
  // v7 新增（契约 §16）：每个模块可挂一份「标准文档」，作为环节间契约，支持人工审核。
  //   卡片全部由 createElement / textContent / appendChild 构造（零 innerHTML）；
  //   瞬态 UI（生成中 / 代码确认 / 执行结果 / 打回反馈）用模块级 map 保存，跨 render() 复用；
  //   编辑态用模块级变量 docEditingId 标记——编辑中该卡片不重建，避免 textarea 内容与焦点丢失。

  var DOC_TITLE = '环节文档 · 标准与验收的契约';
  var DOC_EMPTY_HINT = '尚未创建环节文档。可让 AI 依据本模块的目标 / 验收要点起草，或自己编写。';
  var DOC_STATUS_META = {
    none: { text: '无文档', cls: 'doc-badge-none' },
    draft: { text: '草稿', cls: 'doc-badge-draft' },
    approved: { text: '已审核', cls: 'doc-badge-approved' }
  };

  var docEditingId = null;   // 正在编辑的模块 id（编辑中该卡片不重建；保存/取消后清空）
  var docDraftText = '';     // 编辑态草稿文本（切换模块时保留，避免误丢）
  var docUi = {};            // moduleId -> 瞬态 UI 状态（生成/代码/执行/打回/提示）
  // 【数据清洗闭环 · 2026-10-14】模块级瞬态，跨 render() 保留（编辑/上传/归因展开态不被重建吞掉）：
  var docTemplate = {};      // moduleId -> 'standard'|'align'|'mining'（生成模板选择）
  var docFiles = {};         // moduleId -> [{name,size,content}]（已读入的 UTF-8 文本数据文件）
  // 【X2 · 2026-10-14】迭代反馈 / AI 自动定位 / URL 下载 / 产物预览（模块级瞬态，跨 render 保留）：
  var urlList = {};          // moduleId -> [{url}]（待下载 URL 清单，确认执行时随 body.urls 发送）
  var previewOpen = {};      // moduleId -> { '<artifact下标>': true }（产物预览展开态）

  var TEMPLATE_OPTIONS = [
    { value: 'standard', label: '标准文档' },
    { value: 'align', label: '对齐文档' },
    { value: 'mining', label: '参数挖掘' }
  ];
  var TEMPLATE_DEFAULT = 'standard';
  function docProfile(mod) {
    var type = mod && mod.type;
    var title = '', hint = '', options;
    if (type === 'download-data') { title = '数据下载方案'; hint = '确定数据来源、年份与范围、获取方式、保存格式，以及下载完整性的检查方法。'; }
    if (type === 'clean-data') { title = '数据清洗规则'; hint = '确定字段、单位、缺失和异常处理及验收要求；需要统一国家、品类或统计口径时选择数据对齐规则。'; options = [{ value: 'standard', label: '数据清洗规则' }, { value: 'align', label: '数据对齐规则' }]; }
    if (type === 'calculation') {
      title = mod.mode === 'direct' ? '现有代码运行说明' : mod.mode === 'modify' ? '计算修改方案' : '计算方案';
      hint = mod.mode === 'direct' ? '确定现有代码入口、输入文件、运行参数、输出和检查要求。' : mod.mode === 'modify' ? '确定修改目标、公式或参数变更、影响范围及验证办法。' : '先选择直接计算或修改计算，再确定对应方案。';
    }
    if (type === 'literature-mining') { title = '文献数据提取规则'; hint = '确定文献范围、提取字段、原文位置、缺失处理与人工核查要求。'; options = [{ value: 'mining', label: '文献数据提取规则' }]; }
    if (type === 'result-audit') { title = '结果核查原则'; hint = '确定核查的运行版本、指标、判定依据、通过条件和问题定位办法。'; }
    if (type === 'manual-review') { title = '人工审核要求'; hint = '确定审核对象、证据清单、通过与退回条件。'; }
    if (type === 'plotting') { title = '绘图方案'; hint = '确定要表达的问题、数据来源、图型、单位、样式和交付格式。'; }
    return { title: title || DOC_TITLE, hint: hint || DOC_EMPTY_HINT, options: options || (title ? [{ value: 'standard', label: title }] : TEMPLATE_OPTIONS) };
  }
  var MAX_FILES_TOTAL = 1024 * 1024;   // 数据文件总量上限 1MB（前端先拦，不发送）
  var FILE_ACCEPT = '.csv,.txt,.json,.tsv,.md';
  var RUN_CAUSES = [
    { key: 'data', label: '数据问题' },
    { key: 'code', label: '代码问题' },
    { key: 'doc', label: '标准问题' }
  ];

  // 【X2 · 2026-10-14】AI 自动定位：diagnose 返回 level(data|align|code) → 预选对应归因按钮
  // （服务端 "align"（对齐/标准文档问题）映射为本卡片的「标准问题」）。预选只是初始选中态，
  // 用户点击归因按钮仍会覆盖（确认打回以最终选中为准）。
  var DIAG_LEVEL_META = {
    data: { cause: 'data', label: '数据问题' },
    align: { cause: 'doc', label: '对齐（标准）问题' },
    code: { cause: 'code', label: '代码问题' }
  };

  /** 从 diagnose 输出中解析 {level, reason}：容忍 ```json 围栏与前后杂质（取 {…} 片段），失败返回 null */
  function parseDiagJson(text) {
    var m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      var o = JSON.parse(m[0]);
      if (o && DIAG_LEVEL_META[o.level] && typeof o.reason === 'string') return o;
    } catch (e) { /* 非 JSON：走降级展示 */ }
    return null;
  }

  function uiOf(id) {
    if (!docUi[id]) {
      docUi[id] = {
        gen: false, genErr: '',      // AI 生成标准文档
        code: null, codeLoading: false, codeErr: '',   // 生成代码（待确认执行的代码）
        exec: null, execLoading: false, execErr: '',   // 本机执行结果
        reject: false, rejectNote: '',                 // 文档打回内联反馈
        filesBusy: false, filesErr: '',                // 数据文件（读取中 / 卡片内错误与超限提示）
        runReject: false, runRejectCause: '', runRejectNote: '', runRejectErr: '', // 结果确认门：三级归因
        diagLoading: false, diagText: '', diagErr: '',   // 【X2】AI 自动定位（compose diagnose）
        urlErr: '',                                      // 【X2】URL 添加校验错误
        notice: ''                                     // 成功类提示
      };
    }
    return docUi[id];
  }

  function templateOf(id) {
    var state = getStore().getState();
    var mod = findModule(state.modules, id);
    var options = docProfile(mod).options;
    var selected = docTemplate[id] || options[0].value || TEMPLATE_DEFAULT;
    return options.some(function (option) { return option.value === selected; }) ? selected : options[0].value;
  }

  function filesOf(id) {
    return docFiles[id] || (docFiles[id] = []);
  }
  function templateLabel(mod) {
    var selected = templateOf(mod.id);
    return docProfile(mod).options.filter(function (option) { return option.value === selected; })[0].label;
  }

  /** 【X2】待下载 URL 清单（模块级，跨 render 保留） */
  function urlsOf(id) {
    return urlList[id] || (urlList[id] = []);
  }

  function totalFileSize(id) {
    var list = docFiles[id] || [];
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += (typeof list[i].size === 'number' ? list[i].size : 0);
    return sum;
  }

  /** 字节数 -> 人类可读（B / KB / MB） */
  function formatSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function docStatusOf(mod) {
    var d = mod && mod.doc;
    if (!d) return 'none';
    return d.status === 'approved' ? 'approved' : 'draft';
  }

  /** 文档相关渲染签名：内容/状态/编辑态/瞬态 UI 任一变化都使增量快速路径失效（强制全量重建） */
  function docSigOf(mod) {
    if (!mod) return 'none';
    var d = mod.doc;
    var s = d ? (d.status + '|' + (d.updatedAt || '') + '|' + (d.approvedAt || '') + '|' + d.content.length) : 'none';
    s += '#' + (mod.type || '') + '#' + (mod.mode || '');
    s += '#' + ((docEditingId === mod.id) ? 'E' : '-');
    // 执行记录（结果确认门）：状态/时间/产物任一变化都要全量重建（否则快速路径吞掉徽标翻转）
    var r = mod.run;
    s += '#' + (r ? (r.status + '|' + (r.at || '') + '|' + ((r.artifacts && r.artifacts.length) || 0)) : 'none');
    // 模板选择 + 数据文件清单（模块级瞬态，纳入签名以保证变更后重建）
    s += '#' + templateOf(mod.id) + '#' + ((docFiles[mod.id] && docFiles[mod.id].length) || 0);
    // 【X2】URL 清单 + 产物预览展开数（模块级瞬态，变更后需全量重建）
    s += '#' + ((urlList[mod.id] && urlList[mod.id].length) || 0);
    // 【调研面板 · 2026-10-21】环节①/② 的面板状态也纳入签名。
    // 原因：render() 有「增量快速路径」——只在消息变化时做增量，不重建模块空间。
    // 面板状态（进度条、按钮禁用、候选清单、检索式回填）不在 docSig 里时，
    // 状态一变就被快速路径吞掉，界面看起来"点了完全没反应"。
    var rs = uiOf(mod.id).research;
    if (rs) {
      var perSourceSig = Object.keys(rs.perSource || {}).sort().map(function (key) {
        return key + '=' + (rs.perSource[key] || '');
      }).join(',');
      var sourceResultSig = (rs.sourceResults || []).map(function (meta) {
        return (meta.source_key || '') + ':' + (meta.status || '') + ':' + (meta.count || 0);
      }).join(',');
      s += '#R' + (rs.busy ? 1 : 0) + (rs.planBusy ? 1 : 0) + (rs.screeningBusy ? 1 : 0)
        + '|' + (rs.phase || '') + '|' + (rs.topic || '') + '|' + (rs.query || '')
        + '|' + (rs.plan ? (rs.plan.queries || []).length : 0)
        + '|' + (rs.result ? 1 : 0) + '|' + ((rs.candidates || []).length) + '|' + ((rs.keep || []).length)
        + '|' + (rs.message || '') + '|' + (rs.planMessage || '') + '|' + (rs.model || '')
        // 【多源检索 · 2026-10-22】来源多选 / 逐源检索式 / 逐源命中也必须进签名，
        // 否则勾选来源或检索完成时会被增量快速路径吞掉（本文件已知坑，踩过两次）。
        + '|' + ((rs.sources || []).join(',')) + '|' + perSourceSig + '|' + sourceResultSig
        + '|' + (rs.searchMode || 'test') + ':' + (rs.stopMode || 'count') + ':' + String(rs.perSourceLimit);
    }
    var qs = uiOf(mod.id).question;
    if (qs) {
      s += '#Q' + (qs.busy ? 1 : 0) + '|' + (qs.idea || '') + '|' + ((qs.candidates || []).length)
        + '|' + (qs.spec ? String(qs.spec).length : 0) + '|' + (qs.message || '');
    }
    var pvOpen = previewOpen[mod.id];
    var pvCount = 0;
    for (var pk in pvOpen) { if (Object.prototype.hasOwnProperty.call(pvOpen, pk)) pvCount += 1; }
    s += '#' + pvCount;
    var ui = docUi[mod.id];
    if (ui) {
      s += '|' + (ui.gen ? 1 : 0) + (ui.codeLoading ? 1 : 0) + (ui.execLoading ? 1 : 0) +
        ((ui.code === null || typeof ui.code === 'undefined') ? 0 : 1) + (ui.exec ? 1 : 0) + (ui.reject ? 1 : 0) +
        '|' + (ui.notice || '') + '|' + (ui.genErr || '') + '|' + (ui.codeErr || '') + '|' + (ui.execErr || '') +
        '|' + (ui.rejectNote || '') +
        '|' + (ui.filesBusy ? 1 : 0) + '|' + (ui.filesErr || '') +
        '|' + (ui.runReject ? 1 : 0) + '|' + (ui.runRejectCause || '') + '|' + (ui.runRejectNote || '') +
        '|' + (ui.runRejectErr || '') +
        '|' + (ui.diagLoading ? 1 : 0) + '|' + (ui.diagText || '') + '|' + (ui.diagErr || '') + '|' + (ui.urlErr || '');
    }
    return s;
  }

  /** ISO -> YYYY-MM-DD HH:mm（本地时区）；非法/缺失返回空串 */
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (!d || isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function errorText(prefix, err) {
    return prefix + '：' + ((err && err.message) ? err.message : '未知错误');
  }

  /** 文档卡内按钮：沿用 status-btn 样式；disabled 时不可点（生成中 / 执行中） */
  function docButton(text, kind, disabled, onClick) {
    var btn = el('button', 'status-btn' + (kind === 'primary' ? ' status-btn-primary' : ''), text);
    btn.type = 'button';
    if (disabled) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      onClick();
    });
    return btn;
  }

  /** compose 请求体：mode + template? + 模块 {name, spec} + 消息 + settings（契约 §17 / 第二批冻结接口）。
   *  【X2】extra（可选）：附加字段（code 模式的 feedback；diagnose 模式的 doc/code/exec/issue），
   *  值为 undefined 的字段不写入（不会出现在序列化结果里）。 */
  function composeBody(mode, mod, template, extra) {
    var spec = (mod && mod.spec) ? mod.spec : {};
    var body = {
      mode: mode,
      module: {
        name: (mod && mod.name) ? mod.name : '',
        type: mod && mod.type,
        mode: mod && mod.mode,
        doc: mod && mod.doc && mod.doc.status === 'approved' ? mod.doc : null,
        spec: {
          goal: spec.goal || '',
          todo: Array.isArray(spec.todo) ? spec.todo : [],
          output: spec.output || '',
          acceptance: spec.acceptance || ''
        }
      },
      messages: messagesFor(mod ? mod.id : null),
      settings: readLlmSettings(),
      credential: root.ApiKeys && typeof root.ApiKeys.getActiveCredential === 'function'
        ? root.ApiKeys.getActiveCredential() : null
    };
    // 文档与代码沿用同一适用模板。
    if (template) body.template = template;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key) && typeof extra[key] !== 'undefined') {
          body[key] = extra[key];
        }
      }
    }
    if (root.CodexUI && root.CodexUI.useCodex(mod)) {
      body.backend = 'codex';
      body.codexModel = root.CodexUI.getModel(mod);
      body.settings = null;
      body.credential = null;
    }
    return body;
  }

  /** POST /api/ai/compose，返回 {text, modelUsed, fallbackUsed}；
   *  网络/404/非 ok/空响应都转成语义化 Error（调用方降级显示）。
   *  【2026-10-21】服务端会在主通道拥塞时自动切到同网关的其它免费通道，
   *  modelUsed / fallbackUsed 用来把「这次实际是哪个模型出的结果」如实告诉用户。 */
  function postCompose(mode, mod, template, extra) {
    return fetch('/api/ai/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(composeBody(mode, mod, template, extra))
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        if (!data || typeof data.text !== 'string' || !data.text.trim()) throw new Error('服务返回内容为空');
        return {
          text: data.text,
          modelUsed: (typeof data.modelUsed === 'string') ? data.modelUsed : '',
          fallbackUsed: data.fallbackUsed === true
        };
      });
    });
  }

  /** 降级提示语：只有在真的换了模型时才提示，正常通道下不打扰用户 */
  function modelNote(result) {
    if (!result || !result.fallbackUsed || !result.modelUsed) return '';
    return '（主通道拥塞，已自动改用 ' + result.modelUsed + ' 生成）';
  }

  function enterDocEdit(mod) {
    docEditingId = mod.id;
    docDraftText = (mod.doc && typeof mod.doc.content === 'string') ? mod.doc.content : '';
    uiOf(mod.id).notice = '';
    render();
    var ta = spaceEl ? spaceEl.querySelector('.doc-card .doc-editor') : null;
    if (ta) { try { ta.focus(); } catch (e) { /* 聚焦失败不影响编辑 */ } }
  }

  /** AI 生成标准文档：按所选模板调 compose；按钮 disable + 文案「生成中…」；失败卡片内 textContent 显示错误 */
  function generateDoc(mod, revise) {
    var ui = uiOf(mod.id);
    if (ui.gen || isBusy()) return;
    mod = findModule(getStore().getState().modules, mod.id);
    if (!mod) return;
    if (revise && inputEl && inputEl.value.trim()) { ui.genErr = '请先发送输入框中的修改意见，再点击“AI 总结并修改方案”。'; render(); return; }
    var basis = JSON.stringify(mod.doc || null);
    var discussionBasis = JSON.stringify((mod.messages || []).filter(function (message) { return message.role === 'user' || message.role === 'assistant'; }));
    ui.gen = true; ui.genErr = ''; ui.notice = '';
    render();
    return postCompose('doc', mod, templateOf(mod.id), revise ? { revision: { baseDoc: mod.doc } } : null).then(function (result) {
      ui.gen = false;
      var current = findModule(getStore().getState().modules, mod.id);
      if (!current || JSON.stringify(current.doc || null) !== basis) throw new Error('方案已发生变化，AI 返回内容未覆盖当前方案，请按当前版本重试。');
      if (revise && JSON.stringify((current.messages || []).filter(function (message) { return message.role === 'user' || message.role === 'assistant'; })) !== discussionBasis) throw new Error('讨论中又有新内容，AI 返回内容未覆盖当前方案，请按最新讨论重试。');
      var saved = getStore().saveDoc(mod.id, result.text);
      if (!saved) throw new Error('内容为空、超过 ' + MAX_DOC_CHARS + ' 字，或历史版本无法保存；原方案未改动。');
      ui.code = null; ui.exec = null; ui.codeErr = ''; ui.execErr = '';
      ui.notice = (revise ? '已生成修订草稿，请核对并重新审核。原版本可在“历史方案”中查看。' : '已生成标准文档（草稿），可直接审核或继续编辑。') + modelNote(result);
    }).catch(function (err) {
      ui.genErr = errorText('AI 生成失败', err);
    }).then(function () { ui.gen = false; render(); });
  }

  /** 生成代码：先 compose(code) 拿到代码，进入确认层（不自动执行）。
   *  【X2 · 2026-10-14】迭代闭环：上次执行失败（ui.exec.ok === false）时，把 stderr 尾部 2000 字
   *  作为 feedback 随请求发送，服务端注入提示词让 AI 针对性修复；无失败记录则请求体与旧行为一致。 */
  function composeCode(mod) {
    var ui = uiOf(mod.id);
    if (ui.codeLoading) return;
    var feedback;   // 必须在清空 ui.exec 之前提取
    if (ui.exec && ui.exec.ok === false && typeof ui.exec.stderr === 'string' && ui.exec.stderr) {
      feedback = { stderr: ui.exec.stderr.slice(-2000) };
    }
    ui.codeLoading = true; ui.codeErr = ''; ui.code = null; ui.exec = null; ui.execErr = ''; ui.notice = '';
    ui.genErr = '';
    render();
    postCompose('code', mod, templateOf(mod.id), feedback ? { feedback: feedback } : null).then(function (result) {
      ui.codeLoading = false;
      ui.code = result.text;
      ui.notice = '代码已生成（草稿），确认后再执行。' + modelNote(result);
    }).catch(function (err) {
      ui.codeLoading = false;
      ui.codeErr = errorText('生成代码失败', err);
    }).then(function () { render(); });
  }

  /**
   * 确认执行：POST /api/code/exec（confirm:true, lang:'node'），把已选数据文件（files:[{name,content}]）
   * 一并发送；执行返回结果后写回卡片，并调 Store.markRun 记录执行（进入结果确认门）。
   * 任何网络/非 ok 失败都降级为卡片内 textContent 错误，不抛异常。
   */
  function execCode(mod) {
    var ui = uiOf(mod.id);
    if (ui.execLoading || ui.filesBusy) return;
    if (typeof ui.code !== 'string' || !ui.code) return;
    if (totalFileSize(mod.id) > MAX_FILES_TOTAL) {   // 双保险：超限绝不发送
      ui.filesErr = '数据文件总量超过 1MB，已阻止执行，请移除部分文件。';
      render();
      return;
    }
    ui.execLoading = true; ui.execErr = ''; ui.exec = null;
    ui.filesErr = ''; ui.genErr = ''; ui.codeErr = '';
    render();
    var list = docFiles[mod.id] || [];
    var files = [];
    for (var i = 0; i < list.length; i++) {
      files.push({ name: list[i].name, content: list[i].content });
    }
    // 【X2】URL 数据源：与 files 并存，随 body.urls 发送（服务端逐条下载，结果在响应 downloaded）
    var urlPayload = [];
    var urlItems = urlList[mod.id] || [];
    for (var u = 0; u < urlItems.length; u++) {
      urlPayload.push({ url: urlItems[u].url });
    }
    var execPayload = { lang: 'node', code: ui.code, confirm: true, files: files };
    if (urlPayload.length) execPayload.urls = urlPayload;
    // 【上游产物汇聚 · 2026-10-20】把上游模块的产物目录与文献作业 id 一并带上，
    // 服务端会在脚本启动前复制进 upstream/<模块名>/（文章撰写环节靠它取上游图表与数据）。
    var upstream = collectUpstreamArtifacts(mod.id);
    if (upstream.dirs.length) execPayload.upstream = upstream.dirs;
    if (upstream.jobs.length) execPayload.upstreamJobs = upstream.jobs;
    // 【环节参数 · 2026-10-20】模块参数（如文章撰写的目标期刊）落成 params.json 供脚本读取。
    var modParams = (mod.params && typeof mod.params === 'object') ? mod.params : null;
    if (modParams && Object.keys(modParams).length) execPayload.params = modParams;
    fetch('/api/code/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(execPayload)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        if (!data || typeof data !== 'object') throw new Error('服务返回无效响应');
        return data;
      });
    }).then(function (data) {
      ui.execLoading = false;
      ui.exec = data;
      previewOpen[mod.id] = {};   // 新一轮执行的产物与旧展开下标不对应，重置预览展开态
      // 执行真正发生（HTTP 200 拿到结果，无论脚本 ok 与否）→ 记录执行，进入结果确认门
      var Store = getStore();
      if (Store && Store.markRun) {
        Store.markRun(mod.id, { dir: data.dir, artifacts: data.artifacts });
      }
      ui.runReject = false; ui.runRejectCause = ''; ui.runRejectNote = ''; ui.runRejectErr = '';
      ui.notice = '';
    }).catch(function (err) {
      ui.execLoading = false;
      ui.execErr = errorText('执行失败', err);
    }).then(function () { render(); });
  }

  /* ---- 数据文件（数据清洗闭环）：UTF-8 文本读入，模块级变量持有，跨 render 保留 ---- */

  /**
   * 读取用户选择的数据文件为 UTF-8 文本，追加到 docFiles[mod.id]。
   * 选择前先按声明 size 估算总量，>1MB 直接拦（卡片内提示，不读取、不发送）；读取失败降级提示。
   */
  function addFiles(mod, fileList) {
    var ui = uiOf(mod.id);
    var list = filesOf(mod.id);
    var picked = [];
    for (var i = 0; i < fileList.length; i++) picked.push(fileList[i]);
    if (!picked.length) return;

    // 预估总量（选择时 file.size 已知）→ 超 1MB 前端先拦
    var projected = totalFileSize(mod.id);
    for (var k = 0; k < picked.length; k++) projected += (typeof picked[k].size === 'number' ? picked[k].size : 0);
    if (projected > MAX_FILES_TOTAL) {
      ui.filesBusy = false;
      ui.filesErr = '数据文件总量 ' + formatSize(projected) + ' 超过上限 1MB，已阻止（未读取、未发送）。请减少文件或拆分后再试。';
      render();
      return;
    }

    ui.filesBusy = true; ui.filesErr = '';
    render();

    var remaining = picked.length;
    function done() {
      remaining -= 1;
      if (remaining > 0) return;
      ui.filesBusy = false;
      if (totalFileSize(mod.id) > MAX_FILES_TOTAL) {
        ui.filesErr = '数据文件总量超过 1MB，已阻止执行，请移除部分文件。';
      }
      render();
    }
    for (var j = 0; j < picked.length; j++) {
      (function (file) {
        var reader = new FileReader();
        reader.onload = function () {
          list.push({ name: file.name, size: (typeof file.size === 'number' ? file.size : 0), content: String(reader.result || '') });
          done();
        };
        reader.onerror = function () {
          ui.filesErr = '读取文件失败：' + file.name;
          done();
        };
        try {
          reader.readAsText(file, 'utf-8');
        } catch (e) {
          ui.filesErr = '读取文件失败：' + file.name;
          done();
        }
      })(picked[j]);
    }
  }

  /** 生成区模板下拉：标准文档 / 对齐文档 / 参数挖掘，默认标准；切换写模块级变量（不触发重建） */
  function buildTemplateRow(mod) {
    var row = el('div', 'doc-template-row');
    var options = docProfile(mod).options;
    row.appendChild(el('label', 'doc-template-label', '规则类型'));
    if (options.length === 1) { row.appendChild(el('span', 'doc-template-label', options[0].label)); return row; }
    var sel = el('select', 'doc-template-select');
    sel.setAttribute('aria-label', '规则类型');
    var cur = templateOf(mod.id);
    for (var i = 0; i < options.length; i++) {
      var opt = el('option', 'doc-template-option', options[i].label);
      opt.value = options[i].value;
      if (options[i].value === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      docTemplate[mod.id] = sel.value;
      render();
    });
    row.appendChild(sel);
    return row;
  }

  /** 执行确认层的「数据文件」区：多选读入 + 已选清单（name+size，可移除）+ 超限提示 */
  function buildDocFilesArea(body, mod, ui) {
    var area = el('div', 'doc-files-area');
    area.appendChild(el('div', 'doc-exec-label', '数据文件（可选，UTF-8 文本，单文件与总量均受限）'));

    var input = el('input', 'doc-file-input');
    input.type = 'file';
    input.multiple = true;
    input.accept = FILE_ACCEPT;
    input.addEventListener('change', function () {
      addFiles(mod, input.files);
    });
    area.appendChild(input);

    var list = docFiles[mod.id] || [];
    if (list.length) {
      var ul = el('ul', 'doc-file-list');
      for (var i = 0; i < list.length; i++) {
        (function (file) {
          var li = el('li', 'doc-file-item');
          li.appendChild(el('span', 'doc-file-name', file.name));
          li.appendChild(el('span', 'doc-file-size', formatSize(file.size)));
          var rm = el('button', 'doc-file-remove', '移除');
          rm.type = 'button';
          rm.addEventListener('click', function () {
            var pos = list.indexOf(file);
            if (pos >= 0) list.splice(pos, 1);
            render();
          });
          li.appendChild(rm);
          ul.appendChild(li);
        })(list[i]);
      }
      area.appendChild(ul);
      area.appendChild(el('div', 'doc-file-total',
        '共 ' + list.length + ' 个文件 · ' + formatSize(totalFileSize(mod.id)) + ' / 上限 1MB'));
    } else {
      area.appendChild(el('div', 'doc-file-hint', '尚未选择数据文件'));
    }

    if (ui.filesBusy) area.appendChild(el('div', 'doc-file-hint', '正在读取文件…'));
    if (ui.filesErr) area.appendChild(el('div', 'doc-error', ui.filesErr));

    // 【X2 · 2026-10-14】URL 数据源：输入 URL 加入待下载清单（模块级 urlList），确认执行时随 urls 发送
    area.appendChild(el('div', 'doc-url-label', 'URL 数据源（可选，执行时下载到执行目录供脚本读取）'));
    var urlRow = el('div', 'doc-url-row');
    var urlInput = el('input', 'doc-url-input');
    urlInput.type = 'text';
    urlInput.placeholder = '请输入数据文件的 URL（http 或 https）';
    urlInput.setAttribute('aria-label', '数据文件 URL');
    urlRow.appendChild(urlInput);
    var urlAdd = el('button', 'doc-url-add', '添加');
    urlAdd.type = 'button';
    urlAdd.addEventListener('click', function () {
      var v = String(urlInput.value || '').trim();
      if (!v) { ui.urlErr = '请先填写 URL 再添加'; render(); return; }
      urlsOf(mod.id).push({ url: v });
      ui.urlErr = '';
      render();
    });
    urlRow.appendChild(urlAdd);
    area.appendChild(urlRow);

    var urls = urlList[mod.id] || [];
    if (urls.length) {
      var urlUl = el('ul', 'doc-file-list');
      for (var u = 0; u < urls.length; u++) {
        (function (item) {
          var li = el('li', 'doc-file-item');
          li.appendChild(el('span', 'doc-file-name', item.url));
          var rm = el('button', 'doc-file-remove', '移除');
          rm.type = 'button';
          rm.addEventListener('click', function () {
            var pos = urls.indexOf(item);
            if (pos >= 0) urls.splice(pos, 1);
            render();
          });
          li.appendChild(rm);
          urlUl.appendChild(li);
        })(urls[u]);
      }
      area.appendChild(urlUl);
    }
    if (ui.urlErr) area.appendChild(el('div', 'doc-error', ui.urlErr));
    body.appendChild(area);
  }

  /* ---- 结果确认门（契约 §18）：执行记录 run 的确认 / 三级归因打回 ---- */

  /**
   * 【X2 · 2026-10-14】AI 自动定位：compose(mode='diagnose')，携带文档/代码/上次执行结果/问题描述。
   * 成功解析 {level, reason} → 预选对应归因（高亮）+ 显示推断理由；降级 {text} → 原文展示；
   * 失败 → 卡片内 textContent 错误。预选可被用户改选覆盖（确认打回以最终选中的归因为准）。
   */
  function diagnoseRun(mod, ui) {
    if (ui.diagLoading) return;
    ui.diagLoading = true; ui.diagText = ''; ui.diagErr = '';
    render();
    var execPayload = null;
    if (ui.exec) {
      execPayload = {
        ok: !!ui.exec.ok,
        stderr: (typeof ui.exec.stderr === 'string') ? ui.exec.stderr.slice(-2000) : '',
        artifacts: Array.isArray(ui.exec.artifacts) ? ui.exec.artifacts : []
      };
    }
    var extra = {
      doc: (mod.doc && typeof mod.doc.content === 'string') ? mod.doc.content : undefined,
      code: (typeof ui.code === 'string') ? ui.code : '',
      exec: execPayload,
      issue: ui.runRejectNote || ''
    };
    // diagnose 的成功响应是 {level, reason}（降级 {text}），与 postCompose 期望的 {text} 契约不同，单独处理
    fetch('/api/ai/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(composeBody('diagnose', mod, null, extra))
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        return data;
      });
    }).then(function (data) {
      ui.diagLoading = false;
      var parsed = (data && typeof data.text === 'string') ? parseDiagJson(data.text) : null;
      if (!parsed && data && DIAG_LEVEL_META[data.level]) {
        parsed = { level: data.level, reason: (typeof data.reason === 'string') ? data.reason : '' };
      }
      if (parsed) {
        var meta = DIAG_LEVEL_META[parsed.level];
        ui.runRejectCause = meta.cause; ui.runRejectErr = '';   // 预选对应归因（用户仍可改选）
        ui.diagText = 'AI 推断：' + meta.label + (parsed.reason ? '——' + parsed.reason : '');
      } else if (data && typeof data.text === 'string' && data.text.trim()) {
        ui.diagText = data.text;                                // 解析失败：原样降级展示
      } else {
        ui.diagErr = 'AI 自动定位失败：返回内容无法识别';
      }
    }).catch(function (err) {
      ui.diagLoading = false;
      ui.diagErr = errorText('AI 自动定位失败', err);
    }).then(function () { render(); });
  }

  /** 三级归因 + 反馈框（点「有问题」后展开）。【X2】顶部加 [AI 自动定位]：预选归因 + 推断理由。 */
  function buildRunRejectBox(container, mod, ui) {
    var box = el('div', 'doc-reject-box');
    box.appendChild(el('div', 'doc-exec-label', '三级归因：问题出在哪一环？'));
    var diagRow = el('div', 'doc-diag-row');
    diagRow.appendChild(docButton(ui.diagLoading ? '定位中…' : 'AI 自动定位', '', ui.diagLoading, function () {
      diagnoseRun(mod, ui);
    }));
    box.appendChild(diagRow);
    if (ui.diagText) box.appendChild(el('div', 'doc-diag-result', ui.diagText));
    if (ui.diagErr) box.appendChild(el('div', 'doc-error', ui.diagErr));
    var group = el('div', 'doc-cause-group');
    for (var i = 0; i < RUN_CAUSES.length; i++) {
      (function (c) {
        var active = (ui.runRejectCause === c.key);
        var btn = el('button', 'doc-cause-btn' + (active ? ' doc-cause-btn-active' : ''), c.label);
        btn.type = 'button';
        btn.setAttribute('data-cause', c.key);
        btn.addEventListener('click', function () {
          ui.runRejectCause = c.key; ui.runRejectErr = '';
          render();
        });
        group.appendChild(btn);
      })(RUN_CAUSES[i]);
    }
    box.appendChild(group);

    var ta = el('textarea', 'doc-reject-input');
    ta.maxLength = 2000;
    ta.placeholder = '补充说明（可留空）：例如单位换算导致偏差';
    ta.value = ui.runRejectNote || '';
    ta.addEventListener('input', function () { ui.runRejectNote = ta.value; });
    box.appendChild(ta);

    if (ui.runRejectErr) box.appendChild(el('div', 'doc-error', ui.runRejectErr));

    var acts = el('div', 'doc-actions');
    acts.appendChild(docButton('确认打回', 'primary', false, function () {
      if (!ui.runRejectCause) { ui.runRejectErr = '请先选择归因类型（数据 / 代码 / 标准）'; render(); return; }
      var Store = getStore();
      var ok = Store && Store.rejectRun ? Store.rejectRun(mod.id, ui.runRejectCause, ta.value) : false;
      if (!ok) { ui.runRejectErr = '打回失败：当前没有可打回的执行记录'; render(); return; }
      ui.runReject = false; ui.runRejectCause = ''; ui.runRejectNote = ''; ui.runRejectErr = '';
      render();
    }));
    acts.appendChild(docButton('取消', '', false, function () {
      ui.runReject = false; ui.runRejectCause = ''; ui.runRejectNote = ''; ui.runRejectErr = '';
      render();
    }));
    box.appendChild(acts);
    container.appendChild(box);
  }

  /** 结果确认门：run 存在时渲染护栏（ran→[确认结果]/[有问题]；confirmed→已确认徽标） */
  function buildRunGate(body, mod, ui) {
    if (mod.type === 'download-data') { body.appendChild(el('span', 'status-hint', '在上方下载区域核对文件与来源，确认后交给清洗。')); return; }
    var run = mod && mod.run;
    if (!run) return;
    var gate = el('div', 'doc-run-gate');
    gate.setAttribute('data-run-status', run.status);

    if (run.status === 'confirmed') {
      gate.appendChild(el('div', 'doc-run-confirmed', '本环节产出已确认'));
      var meta = [];
      var at = formatDateTime(run.at);
      if (at) meta.push('运行于 ' + at);
      if (run.dir) meta.push('目录 ' + run.dir);
      if (meta.length) gate.appendChild(el('div', 'doc-run-meta', meta.join(' · ')));
      body.appendChild(gate);
      return;
    }

    var execFailed = !!(ui.exec && ui.exec.ok === false);
    gate.appendChild(el('div', 'doc-run-label', execFailed
      ? '结果确认：最近一次执行未成功——建议走「有问题」归因修复；确有可用产出时也可强制确认。'
      : '结果确认：核对产物后确认通过，或标记有问题并归因。'));
    var acts = el('div', 'doc-actions');
    function confirmAct() {
      var Store = getStore();
      if (Store && Store.confirmRun) Store.confirmRun(mod.id);
      render();
    }
    function rejectAct() {
      ui.runReject = true; ui.runRejectErr = '';
      render();
    }
    if (execFailed) {
      // 【W4 修复】失败态：主按钮为「有问题」，确认降级为次级按钮
      acts.appendChild(docButton('有问题（推荐）', 'primary', false, rejectAct));
      acts.appendChild(docButton('仍要确认结果', '', false, confirmAct));
    } else {
      acts.appendChild(docButton('确认结果', 'primary', false, confirmAct));
      acts.appendChild(docButton('有问题', '', false, rejectAct));
    }
    gate.appendChild(acts);
    if (ui.runReject) buildRunRejectBox(gate, mod, ui);
    body.appendChild(gate);
  }

  /** 标题行：标题 + 状态徽标（data-doc-status + 语义类名）+ 执行状态徽标（data-run-status） */
  function buildDocHead(mod, st) {
    var head = el('div', 'doc-card-head');
    head.appendChild(el('div', 'doc-card-title', docProfile(mod).title));
    var meta = DOC_STATUS_META[st] || DOC_STATUS_META.none;
    var badge = el('span', 'doc-badge ' + meta.cls, meta.text);
    badge.setAttribute('data-doc-status', st);
    head.appendChild(badge);
    // 执行状态徽标：run 存在时显示（ran→待确认 / confirmed→已确认）
    if (mod.run) {
      var runCls = (mod.run.status === 'confirmed') ? 'doc-badge-run-confirmed' : 'doc-badge-run-ran';
      var runText = (mod.run.status === 'confirmed') ? '已确认' : '待确认';
      var runBadge = el('span', 'doc-run-badge ' + runCls, runText);
      runBadge.setAttribute('data-run-status', mod.run.status);
      head.appendChild(runBadge);
    }
    return head;
  }

  function buildDocEmpty(body, mod, ui) {
    body.appendChild(el('div', 'doc-empty-hint', docProfile(mod).hint + ' 先讨论，确定后再起草和审核。'));
    body.appendChild(buildTemplateRow(mod));
    var actions = el('div', 'doc-actions');
    actions.appendChild(docButton(ui.gen ? '生成中…（长任务可能需数分钟）' : 'AI 起草' + templateLabel(mod), 'primary', ui.gen, function () {
      generateDoc(mod);
    }));
    actions.appendChild(docButton('手动编写', '', false, function () {
      enterDocEdit(mod);
    }));
    body.appendChild(actions);
    if (ui.genErr) body.appendChild(el('div', 'doc-error', ui.genErr));
  }

  function buildDocRejectBox(body, mod, ui) {
    var box = el('div', 'doc-reject-box');
    box.appendChild(el('div', 'doc-exec-label', '打回反馈（会写入系统消息，可留空）'));
    var input = el('textarea', 'doc-reject-input');
    input.maxLength = 2000;
    input.placeholder = '例如：验收要点缺少异常场景，请补充后再提交';
    input.value = ui.rejectNote || '';
    input.addEventListener('input', function () { ui.rejectNote = input.value; });
    box.appendChild(input);
    var acts = el('div', 'doc-actions');
    acts.appendChild(docButton('提交打回', 'primary', false, function () {
      getStore().rejectDoc(mod.id, input.value);
      ui.reject = false; ui.rejectNote = '';
      render();
    }));
    acts.appendChild(docButton('取消', '', false, function () {
      ui.reject = false; ui.rejectNote = '';
      render();
    }));
    box.appendChild(acts);
    body.appendChild(box);
  }

  function buildDocCodeLayer(body, mod, ui) {
    var area = el('div', 'doc-exec-area');
    area.appendChild(el('div', 'doc-exec-label', 'AI 生成的执行代码（确认后在本机受限执行）'));
    var pre = el('pre', 'doc-code');
    pre.textContent = ui.code;                 // 代码用 textContent 写入，绝不拼 HTML
    area.appendChild(pre);
    buildDocFilesArea(area, mod, ui);          // 数据文件区（可选）：确认执行时一并 POST
    var acts = el('div', 'doc-actions');
    acts.appendChild(docButton(ui.execLoading ? '执行中…' : '确认执行', 'primary', ui.execLoading || ui.filesBusy, function () {
      execCode(mod);
    }));
    acts.appendChild(docButton('放弃', '', false, function () {
      ui.code = null; ui.exec = null; ui.execErr = ''; ui.codeErr = '';
      render();
    }));
    area.appendChild(acts);
    body.appendChild(area);
  }

  function buildDocExecResult(body, mod, ui) {
    var r = ui.exec;
    var area = el('div', 'doc-exec-result');
    var head = '执行结果：' + (r.ok ? '成功' : '失败');
    if (typeof r.ms === 'number') head += ' · 耗时 ' + r.ms + ' ms';
    area.appendChild(el('div', 'doc-exec-label', head));
    // 【W4 修复 · 2026-10-14】执行失败醒目提示：引导先归因修复，避免对失败结果直接确认
    if (!r.ok) {
      area.appendChild(el('div', 'doc-exec-warning', '脚本未成功执行（详见下方 stderr）。建议先点「有问题」归因并修复后重新执行，不要直接确认结果。'));
    }

    if (typeof r.stdout === 'string' && r.stdout) {
      area.appendChild(el('div', 'doc-exec-label', '标准输出 stdout'));
      var out = el('pre', 'doc-code'); out.textContent = r.stdout; area.appendChild(out);
    }
    if (typeof r.stderr === 'string' && r.stderr) {
      area.appendChild(el('div', 'doc-exec-label', '标准错误 stderr'));
      var errOut = el('pre', 'doc-code'); errOut.textContent = r.stderr; area.appendChild(errOut);
    }

    // 【X2】URL 下载结果：data.downloaded 每条列出（name/ok/error），成功绿 / 失败红
    var dl = Array.isArray(r.downloaded) ? r.downloaded : [];
    if (dl.length) {
      area.appendChild(el('div', 'doc-exec-label', 'URL 下载结果'));
      var dul = el('ul', 'doc-downloaded-list');
      for (var di = 0; di < dl.length; di++) {
        var dItem = dl[di] || {};
        var dName = (dItem.name === null || typeof dItem.name === 'undefined' || dItem.name === '') ? '(未命名)' : String(dItem.name);
        var dText = dItem.ok
          ? dName + ' 下载成功' + (typeof dItem.size === 'number' ? '（' + dItem.size + ' 字节）' : '')
          : dName + ' 下载失败' + (dItem.error ? '：' + dItem.error : '');
        dul.appendChild(el('li', 'doc-downloaded-item' + (dItem.ok ? ' doc-downloaded-ok' : ' doc-downloaded-fail'), dText));
      }
      area.appendChild(dul);
    }

    var arts = Array.isArray(r.artifacts) ? r.artifacts : [];
    if (arts.length) {
      area.appendChild(el('div', 'doc-exec-label', '产物文件'));
      var ul = el('ul', 'doc-artifact-list');
      for (var i = 0; i < arts.length; i++) {
        (function (a, idx) {
          var name = (a.name === null || typeof a.name === 'undefined') ? '(未命名)' : String(a.name);
          var size = (typeof a.size === 'number') ? a.size : null;
          var li = el('li', 'doc-artifact-item');
          li.appendChild(el('span', 'doc-artifact-name', size === null ? name : name + ' （' + size + ' 字节）'));
          // 【X2】产物预览：服务端带回 preview（文本前 50 行）的条目提供展开/收起（模块级展开态）
          var openMap = previewOpen[mod.id] || (previewOpen[mod.id] = {});
          if (typeof a.preview === 'string' && a.preview) {
            var tg = el('button', 'doc-preview-toggle', openMap[idx] ? '收起预览' : '预览');
            tg.type = 'button';
            tg.setAttribute('aria-expanded', openMap[idx] ? 'true' : 'false');
            tg.addEventListener('click', function () {
              if (openMap[idx]) delete openMap[idx]; else openMap[idx] = true;
              render();
            });
            li.appendChild(tg);
            if (openMap[idx]) {
              var pv = el('pre', 'doc-code doc-artifact-preview');
              pv.textContent = a.preview;   // textContent 写入，不拼 HTML
              li.appendChild(pv);
            }
          }
          ul.appendChild(li);
        })(arts[i], i);
      }
      area.appendChild(ul);
    } else {
      area.appendChild(el('div', 'doc-exec-line', '无产物文件'));
    }
    if (typeof r.dir === 'string' && r.dir) {
      area.appendChild(el('div', 'doc-exec-line', '输出目录：' + r.dir));
    }
    buildRunGate(area, mod, ui);      // 结果确认门：确认结果 / 有问题（三级归因）
    body.appendChild(area);
  }

  function buildDocView(body, mod, ui, st) {
    var d = mod.doc;
    body.appendChild(el('div', 'doc-content', d.content));

    var metaParts = [];
    var up = formatDateTime(d.updatedAt);
    if (up) metaParts.push('更新 ' + up);
    if (st === 'approved') {
      var ap = formatDateTime(d.approvedAt);
      if (ap) metaParts.push('审核 ' + ap);
    }
    if (metaParts.length) body.appendChild(el('div', 'doc-meta', metaParts.join(' · ')));

    if (ui.notice) body.appendChild(el('div', 'doc-notice', ui.notice));
    // 【2026-10-21】说清这份文档的职责：它是本环节的验收标准，批准后下游按它执行；
    // 环节本身是否完成、要不要进入下一模块，由上方状态条决定。
    body.appendChild(el('div', 'doc-role-hint',
      '这份文档是本环节的「标准与验收的契约」：批准后它就成为下游环节的输入。'
      + '批准文档 ≠ 环节通过——环节要在上方状态条里「完成并提交审核」→「通过本环节」才会进入下一模块。'));
    if (ui.reject) buildDocRejectBox(body, mod, ui);

    var actions = el('div', 'doc-actions');
    actions.appendChild(docButton('编辑', '', isBusy(), function () { enterDocEdit(mod); }));
    actions.appendChild(docButton(ui.gen ? 'AI 正在修订方案…' : 'AI 总结并修改方案', '', isBusy(), function () { generateDoc(mod, true); }));
    if (st === 'draft') {
      actions.appendChild(docButton('批准这份文档', 'primary', isBusy(), function () {
        getStore().approveDoc(mod.id);
        render();
      }));
      actions.appendChild(docButton('打回', '', isBusy(), function () {
        ui.reject = true; render();
      }));
    } else if (st === 'approved') {
      // run.status === 'confirmed'（本环节产出已确认）时不再提供重新执行入口，引导进入下一步 / 下一模块
      if (mod.run && mod.run.status === 'confirmed') {
        actions.appendChild(el('span', 'status-hint', '本环节产出已确认，请进入下一步或下一个模块'));
      } else if (mod.type === 'literature-mining') {
        actions.appendChild(el('span', 'status-hint', '方案已审核；在上方“文献任务”中核对本次检索设置，再开始执行。'));
      } else if (mod.type === 'download-data') {
        actions.appendChild(docButton('按方案开始下载', 'primary', isBusy(), function () { root.CodexUI.openDownload(mod); }));
      } else if (mod.type === 'calculation' && mod.mode === 'direct') {
        actions.appendChild(el('span', 'status-hint', '按上方“运行现有代码”执行，使用已有代码与输入数据。'));
      } else if (mod.type === 'clean-data' || mod.type === 'calculation') {
        actions.appendChild(docButton(ui.codeLoading ? '生成代码中…（长任务可能需数分钟）' : '生成代码并执行', 'primary', isBusy(), function () {
          composeCode(mod);
        }));
      } else {
        actions.appendChild(el('span', 'status-hint', '当前模块只支持文档协作，暂不开放网页代码执行'));
      }
    }
    body.appendChild(actions);
    body.appendChild(el('div', 'doc-meta', '先在下方对话说明修改要求，再点击“AI 总结并修改方案”。AI 只整理方案，修订后需重新审核。'));
    buildDocHistory(body, mod, ui);

    // 【2026-10-22】文档已批准后，把「环节推进」的操作**就近**放进卡片里。
    // 文档卡常常很长、内部还有滚动，而状态条在模块空间顶部——批准完要往上滚才点得到，很别扭。
    // 这里给的按钮与状态条是同一套动作，只是位置就近。
    if (st === 'approved') {
      var advStore = getStore();
      var advState = (advStore && advStore.getState) ? advStore.getState() : null;
      var advMods = (advState && advState.modules) || [];
      var modStatus = statusOf(mod);
      var nextMod = null;
      for (var mi = 0; mi < advMods.length; mi++) {
        if (advMods[mi].id === mod.id) {
          nextMod = (mi + 1 < advMods.length) ? advMods[mi + 1] : null;
          break;
        }
      }
      var advance = el('div', 'doc-advance');
      if (modStatus === 'todo' || modStatus === 'doing') {
        advance.appendChild(docButton('提交本环节审核', 'primary', false, function () {
          getStore().submitModule(mod.id);
          render();
        }));
      } else if (modStatus === 'review') {
        advance.appendChild(docButton('通过本环节 → 下一模块', 'primary', false, function () {
          getStore().approveModule(mod.id);
          render();
        }));
        advance.appendChild(docButton('打回重做', '', false, function () {
          getStore().rejectModule(mod.id, '需要补充后再提交');
          render();
        }));
      } else if (modStatus === 'approved' && nextMod) {
        advance.appendChild(docButton('进入下一模块：' + nextMod.name + ' →', 'primary', false, function () {
          getStore().selectModule(nextMod.id);
          render();
        }));
      }
      if (advance.childNodes.length) {
        advance.appendChild(el('span', 'doc-advance-hint', '与上方状态条是同一个动作，就近放在这里'));
        body.appendChild(advance);
      }
    }

    // 【X2】迭代闭环提示：上次执行失败 → 本次「生成代码并执行」已附带 stderr 反馈（仅在按钮可见时显示）
    if (st === 'approved' && !(mod.run && mod.run.status === 'confirmed') &&
        ui.exec && ui.exec.ok === false) {
      body.appendChild(el('div', 'doc-feedback-hint', '已附带上次失败信息，AI 将针对性修复'));
    }

    if (st === 'draft') body.appendChild(buildTemplateRow(mod));
    if (ui.genErr) body.appendChild(el('div', 'doc-error', ui.genErr));
    if (ui.codeErr) body.appendChild(el('div', 'doc-error', ui.codeErr));
    if (typeof ui.code === 'string' && ui.code) buildDocCodeLayer(body, mod, ui);
    if (ui.exec) buildDocExecResult(body, mod, ui);
    else if (mod.run) buildRunGate(body, mod, ui);   // 刷新后 ui.exec 丢失但 run 仍在：仍渲染确认门
    if (ui.execErr) body.appendChild(el('div', 'doc-error', ui.execErr));
  }

  function buildDocHistory(body, mod, ui) {
    var versions = getStore().getDocHistory(mod.id);
    if (!versions.length) return;
    var details = el('details', 'doc-plan-history');
    details.appendChild(el('summary', '', '历史方案 · ' + versions.length + ' 个版本'));
    versions.slice().reverse().forEach(function (version, index) {
      var entry = el('div', 'doc-plan-version');
      entry.appendChild(el('div', 'doc-meta', '版本 ' + (versions.length - index) + ' · ' + (version.status === 'approved' ? '曾审核通过' : '草稿') + ' · ' + formatDateTime(version.updatedAt)));
      entry.appendChild(el('div', 'doc-content', version.content));
      entry.appendChild(docButton('恢复为草稿', '', isBusy(), function () {
        if (!getStore().saveDoc(mod.id, version.content)) { ui.genErr = '历史版本无法保存，当前方案未改动。'; render(); return; }
        ui.genErr = ''; ui.notice = '历史方案已恢复为草稿；请核对并重新审核。';
        ui.code = null; ui.exec = null; render();
      }));
      details.appendChild(entry);
    });
    body.appendChild(details);
  }

  function buildDocEditor(body, mod) {
    var ta = el('textarea', 'doc-editor');
    ta.maxLength = MAX_DOC_CHARS;
    ta.placeholder = '撰写本环节的标准与验收契约…（最长 ' + MAX_DOC_CHARS + ' 字）';
    ta.value = docDraftText;
    ta.addEventListener('input', function () { docDraftText = ta.value; });
    body.appendChild(ta);

    var ui = uiOf(mod.id);
    var actions = el('div', 'doc-actions');
    actions.appendChild(docButton('保存', 'primary', false, function () {
      var text = ta.value;
      if (!String(text).trim()) { ui.genErr = '保存失败：内容不能为空'; render(); return; }
      if (String(text).length > MAX_DOC_CHARS) { ui.genErr = '保存失败：超过 ' + MAX_DOC_CHARS + ' 字'; render(); return; }
      var saved = getStore().saveDoc(mod.id, text);
      if (!saved) { ui.genErr = '保存失败：内容无效或历史版本无法保存，原方案未改动。'; render(); return; }
      ui.genErr = ''; ui.code = null; ui.exec = null; ui.codeErr = ''; ui.execErr = '';
      ui.notice = '文档已保存为草稿。';
      docEditingId = null; docDraftText = '';
      render();
    }));
    actions.appendChild(docButton('取消', '', false, function () {
      docEditingId = null; docDraftText = '';
      render();
    }));
    body.appendChild(actions);
    if (ui.genErr) body.appendChild(el('div', 'doc-error', ui.genErr));
  }

  /** 环节文档卡：标题行 + 状态徽标 + 依据状态渲染（无 / view / edit） */
  function buildDocCard(mod) {
    var st = docStatusOf(mod);
    var ui = uiOf(mod.id);
    var card = el('div', 'doc-card');
    card.setAttribute('data-module-id', mod.id);
    card.setAttribute('data-doc-status', st);
    if (mod.run && mod.run.status) card.setAttribute('data-run-status', mod.run.status);
    card.appendChild(buildDocHead(mod, st));

    var body = el('div', 'doc-body');
    card.appendChild(body);

    if (docEditingId === mod.id) {
      buildDocEditor(body, mod);
    } else if (st === 'none') {
      buildDocEmpty(body, mod, ui);
    } else {
      buildDocView(body, mod, ui, st);
    }
    return card;
  }

  // ------------------------------------------------------------------ 渲染

  /**
   * 渲染模块独立空间 + 输入区状态。幂等：只重建 #module-space 内部（自己的容器）。
   * 无模块 / 未选中模块时禁用输入框，并给出对应占位提示。
   */
  function render() {
    if (root.TaskManager && root.TaskManager.refreshControls) root.TaskManager.refreshControls();
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

    // ---- 编辑态守卫：正在编辑当前模块且编辑卡仍在 DOM 中 -> 不重建（保住草稿与焦点）----
    if (docEditingId && active && docEditingId === active.id) {
      var liveEditor = spaceEl.querySelector('.doc-card .doc-editor');
      if (liveEditor) {
        var pendingLive = !!pendingModules[active.id];
        if (fallback) setComposerEnabled(false, PLACEHOLDER_NO_ACTIVE);
        else setComposerEnabled(!pendingLive, pendingLive ? 'AI 正在回复…' : PLACEHOLDER_DEFAULT);
        return;
      }
    }

    // ---- 增量快速路径：纯消息追加（含 AI pending 指示翻转），其余一律全量 ----
    // 文档卡任一变化（内容/状态/编辑态/生成与执行瞬态）都会使 docSigOf 改变 -> 强制全量重建。
    var pendingNow = active ? !!pendingModules[active.id] || !!uiOf(active.id).gen : false;
    var canFast = !!active && !fallback &&
      msgListState.moduleId === active.id &&
      msgListState.count >= 0 &&
      messages.length >= msgListState.count &&
      (msgListState.count === 0 || messages[0].id === msgListState.firstId) &&
      (active.status || 'todo') === msgListState.status &&
      pendingNow === msgListState.pending &&
      docSigOf(active) === msgListState.docSig;
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

    // 零 innerHTML：清空自己的容器时逐个移除子节点
    while (spaceEl.firstChild) spaceEl.removeChild(spaceEl.firstChild);

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

      // 顺序：状态条（动作优先）-> 任务说明卡 -> 环节文档卡 -> 消息列表
      spaceEl.appendChild(buildStatusBar(active, modules));
      var specCard = buildSpecCard(active);
      if (specCard) spaceEl.appendChild(specCard);
      var researchPanel = buildResearchPanel(active);
      if (researchPanel) spaceEl.appendChild(researchPanel);
      var questionPanel = buildQuestionPanel(active);
      if (questionPanel) spaceEl.appendChild(questionPanel);
      if (!(active.type === 'calculation' && active.mode === 'modify') && active.type !== 'plotting') spaceEl.appendChild(buildDocCard(active));

      var list = el('div', 'msg-list');
      if (!messages.length) {
        list.appendChild(emptyState(active.name,
          '输入研究目标或已有材料。切换到 AI 对话后，助手会依据本模块工作流协助你补齐输入、推进执行并检查交付。'));
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
        var busy = pendingModules[active.id] || (root.CodexUI && root.CodexUI.busy(active.id));
        setComposerEnabled(!busy, busy ? 'AI 正在回复…' : PLACEHOLDER_DEFAULT);
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
      pending: (active && !fallback) ? !!pendingModules[active.id] : false,
      docSig: (active && !fallback) ? docSigOf(active) : null
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
    if (pendingModules[id] || (root.CodexUI && root.CodexUI.busy(id)) || docUi[id] && docUi[id].gen) return;
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

  function sendText(text) {
    if (!inputEl) inputEl = document.getElementById('composer-input');
    if (!inputEl || !text || !activeModuleId() || isBusy()) return false;
    inputEl.value = text;
    send();
    return true;
  }

  function isBusy() {
    if (root.LiteratureUI && root.LiteratureUI.isBusy()) return true;
    var state = getStore().getState();
    return (state.modules || []).some(function (mod) {
      var ui = docUi[mod.id];
      return !!(pendingModules[mod.id] || (root.CodexUI && root.CodexUI.busy(mod.id)) || ui && (ui.gen || ui.codeLoading || ui.execLoading));
    });
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

  root.ModuleSpace = { render: render, sendText: sendText, isBusy: isBusy };
})(typeof window !== 'undefined' ? window : this);
