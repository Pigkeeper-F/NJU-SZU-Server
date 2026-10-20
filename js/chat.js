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
    var cursor = mod.dependsOn;
    while (cursor && !visited[cursor]) {
      visited[cursor] = true;
      var up = findModule(modules, cursor);
      if (!up) break;
      if (up.doc && up.doc.status === 'approved' && typeof up.doc.content === 'string') {
        upstream.push({ name: up.name, doc: up.doc.content.slice(0, 400) });
      }
      cursor = up.dependsOn;
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
  function buildResearchPanel(mod) {
    if (!mod || mod.type !== 'literature-research') return null;
    var state = uiOf(mod.id).research || (uiOf(mod.id).research = { topic: '', query: '', busy: false, message: '', result: null });
    var box = el('div', 'research-panel');

    var topicRow = el('label', 'research-field');
    topicRow.appendChild(el('span', 'research-label', '主题'));
    var topicInput = el('input', 'research-input');
    topicInput.type = 'text';
    topicInput.placeholder = '研究主题（用于检索式与后续归纳）';
    topicInput.value = state.topic || '';
    topicInput.addEventListener('input', function () { state.topic = topicInput.value; });
    topicRow.appendChild(topicInput);
    box.appendChild(topicRow);

    var queryRow = el('label', 'research-field');
    queryRow.appendChild(el('span', 'research-label', '检索式'));
    var queryInput = el('input', 'research-input');
    queryInput.type = 'text';
    queryInput.placeholder = 'Google Scholar 检索式，如 ("long-term fertilization") "soil organic carbon"';
    queryInput.value = state.query || '';
    queryInput.addEventListener('input', function () { state.query = queryInput.value; });
    queryRow.appendChild(queryInput);
    box.appendChild(queryRow);

    var actions = el('div', 'research-actions');
    var runBtn = el('button', 'status-btn status-btn-primary', state.busy ? '调研中…' : '检索并生成要点');
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

    if (state.result) {
      var sum = el('div', 'research-summary');
      var meta = state.result.meta || {};
      sum.appendChild(el('div', 'research-summary-line',
        '文献 ' + (meta.candidate_count || 0) + ' 篇（有全文 ' + (meta.with_fulltext || 0) + ' 篇）'
        + '｜要点 ' + ((state.result.notes || []).length) + ' 条'
        + '｜空白 ' + ((state.result.gaps || []).length) + ' 条'));
      var files = (state.result.files || []).join('、');
      if (files) sum.appendChild(el('div', 'research-summary-line research-files', '产物：' + files));
      box.appendChild(sum);
    }
    return box;
  }

  function researchPost(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
      body: JSON.stringify(body)
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

  /** 环节①一键调研：检索 → 等作业完成 → 抽要点与空白。 */
  function runResearch(mod) {
    var state = uiOf(mod.id).research;
    if (!state || state.busy) return;
    if (!state.topic || !state.query) {
      state.message = '请先填主题与检索式';
      render();
      return;
    }
    state.busy = true;
    state.message = '检索中…';
    state.result = null;
    render();

    var jobId = '';
    researchPost('/api/literature/search', {
      config: { topic: state.topic, query: state.query, sources: ['google-scholar'], limit: 10 }
    }).then(function (started) {
      jobId = started && started.id ? started.id : '';
      if (!jobId) throw new Error('检索作业没有返回标识');
      state.message = '检索中（作业 ' + jobId.slice(0, 8) + '…）…';
      render();
      // 轮询作业状态：检索阶段完成后才做要点抽取
      var waited = 0;
      function poll() {
        return researchGet('/api/literature/job?id=' + encodeURIComponent(jobId)).then(function (job) {
          waited += 1500;
          if (job.status === 'running' || job.status === 'queued') {
            if (waited > 240000) throw new Error('检索超时（超过 4 分钟）');
            state.message = '检索中（作业 ' + jobId.slice(0, 8) + '…）…';
            render();
            return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(poll);
          }
          if (job.status === 'failed') throw new Error(job.error || '检索失败');
          return job;
        });
      }
      return poll();
    }).then(function () {
      state.message = '抽取要点与研究空白中…';
      render();
      return researchPost('/api/literature/research', { jobId: jobId, settings: readLlmSettings() || {} });
    }).then(function (result) {
      state.busy = false;
      state.result = result;
      state.message = result && result.ok
        ? '完成：' + ((result.notes || []).length) + ' 篇要点、' + ((result.gaps || []).length) + ' 条研究空白'
        : ('部分完成：' + ((result && result.error) || '模型返回异常'));
      var Store = getStore();
      if (Store && Store.appendMessage) {
        Store.appendMessage(mod.id, '文献调研产物：' + state.message + '。产物在检索作业 ' + jobId.slice(0, 8) + ' 的 research/ 目录下。', 'system');
      }
      render();
    }).catch(function (error) {
      state.busy = false;
      state.message = '失败：' + ((error && error.message) || '未知错误');
      render();
    });
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
      cursor = up.dependsOn;
    }
    return { dirs: dirs, jobs: jobs };
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
    return docTemplate[id] || TEMPLATE_DEFAULT;
  }

  function filesOf(id) {
    return docFiles[id] || (docFiles[id] = []);
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
    s += '#' + ((docEditingId === mod.id) ? 'E' : '-');
    // 执行记录（结果确认门）：状态/时间/产物任一变化都要全量重建（否则快速路径吞掉徽标翻转）
    var r = mod.run;
    s += '#' + (r ? (r.status + '|' + (r.at || '') + '|' + ((r.artifacts && r.artifacts.length) || 0)) : 'none');
    // 模板选择 + 数据文件清单（模块级瞬态，纳入签名以保证变更后重建）
    s += '#' + templateOf(mod.id) + '#' + ((docFiles[mod.id] && docFiles[mod.id].length) || 0);
    // 【X2】URL 清单 + 产物预览展开数（模块级瞬态，变更后需全量重建）
    s += '#' + ((urlList[mod.id] && urlList[mod.id].length) || 0);
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
    // 模板仅在生成标准文档时叠加（生成代码不传，服务端忽略未知字段亦安全）
    if (template) body.template = template;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key) && typeof extra[key] !== 'undefined') {
          body[key] = extra[key];
        }
      }
    }
    return body;
  }

  /** POST /api/ai/compose，返回 text；网络/404/非 ok/空响应都转成语义化 Error（调用方降级显示） */
  function postCompose(mode, mod, template, extra) {
    return fetch('/api/ai/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(composeBody(mode, mod, template, extra))
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error((data && data.error) || ('服务返回 HTTP ' + response.status));
        if (!data || typeof data.text !== 'string' || !data.text.trim()) throw new Error('服务返回内容为空');
        return data.text;
      });
    });
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
  function generateDoc(mod) {
    var ui = uiOf(mod.id);
    if (ui.gen) return;
    ui.gen = true; ui.genErr = ''; ui.notice = '';
    render();
    postCompose('doc', mod, templateOf(mod.id)).then(function (text) {
      ui.gen = false;
      var saved = getStore().saveDoc(mod.id, text);
      if (!saved) throw new Error('生成内容为空或超过 ' + MAX_DOC_CHARS + ' 字，未写入');
      ui.code = null; ui.exec = null; ui.codeErr = ''; ui.execErr = '';
      ui.notice = '已生成标准文档（草稿），可直接审核或继续编辑。';
    }).catch(function (err) {
      ui.gen = false;
      ui.genErr = errorText('AI 生成失败', err);
    }).then(function () { render(); });
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
    postCompose('code', mod, null, feedback ? { feedback: feedback } : null).then(function (text) {
      ui.codeLoading = false;
      ui.code = text;
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
    row.appendChild(el('label', 'doc-template-label', '生成模板'));
    var sel = el('select', 'doc-template-select');
    var cur = templateOf(mod.id);
    for (var i = 0; i < TEMPLATE_OPTIONS.length; i++) {
      var opt = el('option', 'doc-template-option', TEMPLATE_OPTIONS[i].label);
      opt.value = TEMPLATE_OPTIONS[i].value;
      if (TEMPLATE_OPTIONS[i].value === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      docTemplate[mod.id] = sel.value;
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
    head.appendChild(el('div', 'doc-card-title', DOC_TITLE));
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
    body.appendChild(el('div', 'doc-empty-hint', DOC_EMPTY_HINT));
    body.appendChild(buildTemplateRow(mod));
    var actions = el('div', 'doc-actions');
    actions.appendChild(docButton(ui.gen ? '生成中…（长任务可能需数分钟）' : 'AI 生成标准文档', 'primary', ui.gen, function () {
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
    if (ui.reject) buildDocRejectBox(body, mod, ui);

    var actions = el('div', 'doc-actions');
    actions.appendChild(docButton('编辑', '', false, function () { enterDocEdit(mod); }));
    if (st === 'draft') {
      actions.appendChild(docButton('审核通过', 'primary', false, function () {
        getStore().approveDoc(mod.id);
        render();
      }));
      actions.appendChild(docButton('打回', '', false, function () {
        ui.reject = true; render();
      }));
      actions.appendChild(docButton(ui.gen ? '生成中…（长任务可能需数分钟）' : '重新生成', '', ui.gen, function () {
        generateDoc(mod);
      }));
    } else if (st === 'approved') {
      // run.status === 'confirmed'（本环节产出已确认）时不再提供重新执行入口，引导进入下一步 / 下一模块
      if (mod.run && mod.run.status === 'confirmed') {
        actions.appendChild(el('span', 'status-hint', '本环节产出已确认，请进入下一步或下一个模块'));
      } else if (mod.type === 'clean-data' || mod.type === 'calculation') {
        actions.appendChild(docButton(ui.codeLoading ? '生成代码中…（长任务可能需数分钟）' : '生成代码并执行', 'primary', ui.codeLoading, function () {
          composeCode(mod);
        }));
      } else {
        actions.appendChild(el('span', 'status-hint', '当前模块只支持文档协作，暂不开放网页代码执行'));
      }
    }
    body.appendChild(actions);

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
      if (!saved) { ui.genErr = '保存失败：内容无效'; render(); return; }
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
    var pendingNow = active ? !!pendingModules[active.id] : false;
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
      spaceEl.appendChild(buildDocCard(active));

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
    if (pendingModules[id] || (root.CodexUI && root.CodexUI.busy(id))) return;
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
    var state = getStore().getState();
    return (state.modules || []).some(function (mod) {
      return !!(pendingModules[mod.id] || (root.CodexUI && root.CodexUI.busy(mod.id)));
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
