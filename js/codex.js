/* Local Codex connection and task files for the cleaning module. */
(function (root) {
  'use strict';
  const tasks = {};
  const key = 'research_codex_tasks_v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_) {}
  let account = null;
  let checking = false;
  const panel = document.createElement('section');
  panel.className = 'codex-panel';
  panel.hidden = true;
  document.getElementById('module-space').before(panel);
  function persist() { try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {} }
  function task(id) {
    if (!tasks[id]) tasks[id] = { files: [], busy: false, backend: saved[id]?.backend || 'codex', model: saved[id]?.model || '', execute: false, executeOnce: false, error: '', job: null, filesOpen: false, logOpen: false,
      literatureConfig: saved[id]?.literatureConfig || null, literatureJob: null, literatureBusy: false, literatureError: '' };
    return tasks[id];
  }
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', ...(options.headers || {}) } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '本地服务请求失败');
    return data;
  }
  async function session(id) {
    saved[id] = saved[id] || {};
    if (!saved[id].sessionId) {
      const mod = Store.getState().modules.find(item => item.id === id);
      if (mod?.type === 'result-audit') {
        const calculation = Store.getState().modules.find(item => item.type === 'calculation');
        if (!calculation) throw new Error('请先建立计算模块');
        saved[id].sessionId = await session(calculation.id);
      } else {
        const data = await request('/api/codex/session', { method: 'POST' });
        saved[id].sessionId = data.id;
      }
      persist();
    }
    return saved[id].sessionId;
  }
  async function refresh(id) {
    const t = task(id);
    try {
      const sid = await session(id);
      t.files = (await request('/api/codex/files?session=' + sid)).files;
      t.error = '';
    } catch (error) { t.error = error.message; }
    render();
  }
  async function check() {
    checking = true; render();
    try { account = await request('/api/codex/status'); }
    catch (error) { account = { loggedIn: false, error: error.message }; }
    checking = false; render();
  }
  async function upload(id, files, group = 'input') {
    const t = task(id); if (t.busy) return;
    t.busy = true; t.error = ''; render();
    try {
      const sid = await session(id);
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ' 超过 20MB');
        t.files = (await request('/api/codex/upload?session=' + sid + '&group=' + group + '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file })).files;
      }
    } catch (error) { t.error = error.message; }
    finally { t.busy = false; t.filesOpen = false; render(); ModuleSpace.render(); }
  }
  async function watch(id, jobId) {
    const t = task(id); t.busy = true;
    try {
      while (true) {
        const job = await request('/api/codex/job?id=' + jobId);
        t.job = job; t.files = job.files; render();
        if (job.status !== 'running') {
          if (saved[id]?.delivered !== job.id) {
            if (job.text) Store.appendMessage(id, job.text, 'assistant');
            if (job.status !== 'completed') Store.appendMessage(id, 'Codex：' + (job.error || (job.status === 'cancelled' ? '任务已停止，部分输出请检查后使用。' : '任务失败')), 'system');
            const state = Store.getState();
            const source = state.modules.find(item => item.id === id);
            const audit = source?.type === 'calculation' && state.modules.find(item => item.type === 'result-audit');
            if (audit && job.status === 'completed') {
              task(audit.id).files = job.files;
              Store.appendMessage(audit.id, '计算产生了新运行结果（' + job.id + '）。先前核查结论不自动适用于这次结果，请按运行版本重新核查。', 'system');
            }
            saved[id].delivered = job.id; persist();
          }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (error.message.includes('运行记录不存在')) {
        if (saved[id]?.jobId === jobId) {
          delete saved[id].jobId;
          persist();
          Store.appendMessage(id, '之前的 Codex 任务因服务重启已结束，请重新发送需要执行的消息。已上传和输出文件仍可在“文件与结果”中查看。', 'system');
        }
        t.error = '';
        return;
      }
      t.error = error.message;
      Store.appendMessage(id, 'Codex 状态获取失败：' + error.message + '。可刷新页面尝试恢复运行。', 'system');
      // Preserve job id on a transient failure; refresh can reattach.
      throw error;
    } finally { t.busy = false; render(); ModuleSpace.render(); }
    delete saved[id].jobId; persist();
  }
  async function watchLiterature(id, jobId) {
    const t = task(id);
    t.literatureBusy = true;
    try {
      while (true) {
        const job = await request('/api/literature/job?id=' + encodeURIComponent(jobId));
        t.literatureJob = job;
        render();
        if (job.status !== 'running') {
          if (saved[id]?.literatureDelivered !== job.id) {
            const text = job.status === 'completed'
              ? '首批候选检索已保存 ' + job.count + ' 条待复核记录；这不是已纳入文献，也未提取全文。可在文献检索区下载清单。'
              : job.status === 'needs_attention' ? 'Google Scholar 需要人工验证。请在检索浏览器完成后点击“重新检索”。'
              : '文献检索' + (job.status === 'cancelled' ? '已停止' : '未完成') + '：' + (job.error || job.message);
            Store.appendMessage(id, text, 'system');
            saved[id].literatureDelivered = job.id; persist();
          }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      t.literatureError = '';
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function startLiterature(mod) {
    const t = task(mod.id);
    const config = t.literatureConfig;
    if (!config) { t.literatureError = '请先从对话整理运行配置并核对'; render(); return; }
    if (saved[mod.id]?.literatureSource !== literatureSource(mod)) { t.literatureError = '对话或已批准文档有更新，请重新整理规则后再检索'; render(); return; }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const resumeCurrent = t.literatureJob?.status === 'needs_attention' && literatureConfigKey(t.literatureJob.config) === literatureConfigKey(config);
      const job = await request('/api/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, resumeCurrent }) });
      t.literatureJob = job;
      saved[mod.id] = { ...saved[mod.id], literatureJobId: job.id, literatureConfig: config };
      persist();
      await watchLiterature(mod.id, job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  function literatureSource(mod) {
    const entries = (mod.messages || []).filter(message => message.role === 'user' || message.role === 'assistant');
    return JSON.stringify({ messages: entries.map(message => [message.id, message.at]),
      approvedDoc: mod.doc?.status === 'approved' ? [mod.doc.content, mod.doc.approvedAt] : null });
  }
  function literatureConfigKey(config) {
    if (!config) return '';
    return JSON.stringify(['topic', 'query', 'sources', 'publicationYearFrom', 'publicationYearTo', 'geography', 'language',
      'studyTypes', 'inclusion', 'exclusion', 'targetFields', 'limit'].map(key => config[key] ?? null));
  }
  function parseLiteratureConfig(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 未返回运行配置；请重试或手动填写');
    const config = JSON.parse(raw.slice(start, end + 1));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AI 返回的配置格式无效');
    if (!Array.isArray(config.sources)) throw new Error('AI 未明确返回检索来源，请重新整理规则');
    return {
      topic: String(config.topic || ''), query: String(config.query || ''),
      sources: config.sources,
      publicationYearFrom: config.publicationYearFrom ?? null, publicationYearTo: config.publicationYearTo ?? null,
      geography: String(config.geography || ''), language: String(config.language || ''),
      studyTypes: Array.isArray(config.studyTypes) ? config.studyTypes : [],
      inclusion: Array.isArray(config.inclusion) ? config.inclusion : [],
      exclusion: Array.isArray(config.exclusion) ? config.exclusion : [],
      targetFields: Array.isArray(config.targetFields) ? config.targetFields : [],
      limit: config.limit ?? 10
    };
  }
  async function prepareLiterature(mod) {
    const t = task(mod.id);
    const messages = (mod.messages || []).filter(message => message.role === 'user' || message.role === 'assistant').slice(-30)
      .map(message => ({ role: message.role, text: message.text }));
    if (!messages.some(message => message.role === 'user')) { t.literatureError = '当前模块还没有用户提出的检索需求；请先讨论主题与检索规则'; render(); return; }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const source = literatureSource(mod);
      const sid = await session(mod.id);
      const started = await request('/api/literature/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, messages, approvedDoc: mod.doc?.status === 'approved' ? mod.doc.content : '' }) });
      let job = started;
      while (job.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1200));
        job = await request('/api/codex/job?id=' + encodeURIComponent(started.id));
      }
      if (job.status !== 'completed') throw new Error(job.error || '整理规则失败');
      t.literatureConfig = parseLiteratureConfig(job.text);
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureSource: source };
      persist();
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  function manualLiterature(mod) {
    const t = task(mod.id);
    t.literatureConfig = { topic: '', query: '', sources: ['google-scholar'], publicationYearFrom: null, publicationYearTo: null,
      geography: '', language: '', studyTypes: [], inclusion: [], exclusion: [], targetFields: [], limit: 10 };
    saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureSource: literatureSource(mod) };
    persist(); render();
  }
  function literaturePanel(mod, t) {
    const box = node('div', undefined, 'literature-connector');
    box.append(node('p', '对话确认规则 → 核对运行配置 → 首批检索。当前仅 Google Scholar 已接通；纳排与目标字段随配置保存，尚不自动筛选或提取全文。'));
    const row = node('div', undefined, 'codex-toolbar literature-toolbar');
    const prepare = node('button', t.literatureBusy ? '处理中…' : '从对话整理规则', 'quiet-button');
    prepare.type = 'button'; prepare.disabled = t.literatureBusy || t.busy; prepare.onclick = () => prepareLiterature(mod); row.append(prepare);
    if (!t.literatureConfig) {
      const manual = node('button', '手动填写', 'quiet-button'); manual.type = 'button'; manual.disabled = t.literatureBusy || t.busy;
      manual.onclick = () => manualLiterature(mod); row.append(manual);
    }
    const start = node('button', t.literatureJob?.status === 'needs_attention' ? '验证后重新检索' : '确认配置并检索', 'primary-button');
    start.type = 'button'; start.disabled = t.literatureBusy || t.busy || !t.literatureConfig;
    start.onclick = () => startLiterature(mod); row.append(start);
    if (t.literatureJob?.status === 'running') {
      const stop = node('button', '停止', 'quiet-button'); stop.type = 'button';
      stop.onclick = async () => {
        try { t.literatureJob = await request('/api/literature/cancel?id=' + encodeURIComponent(t.literatureJob.id), { method: 'POST' }); }
        catch (error) { t.literatureError = error.message; }
        render();
      };
      row.append(stop);
    }
    box.append(row);
    if (t.literatureConfig) {
      const config = t.literatureConfig;
      const details = node('details', undefined, 'literature-config'); details.open = true;
      details.append(node('summary', '核对本次运行配置' + (saved[mod.id]?.literatureSource !== literatureSource(mod) ? ' · 对话已更新' : '')));
      const fields = node('div', undefined, 'literature-config-fields');
      function input(label, key, type = 'text') {
        const wrap = node('label', label); const field = node('input'); field.type = type;
        if (type === 'number') { field.min = key === 'limit' ? '1' : '1800'; field.max = key === 'limit' ? '10' : String(new Date().getFullYear() + 1); }
        field.value = config[key] ?? ''; field.oninput = () => { config[key] = type === 'number' ? (field.value ? Number(field.value) : null) : field.value; persistConfig(); };
        wrap.append(field); fields.append(wrap);
      }
      function lines(label, key) {
        const wrap = node('label', label); const field = node('textarea'); field.rows = 2; field.value = (config[key] || []).join('\n');
        field.oninput = () => { config[key] = field.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); persistConfig(); };
        wrap.append(field); fields.append(wrap);
      }
      function persistConfig() { saved[mod.id] = { ...saved[mod.id], literatureConfig: config }; persist(); }
      input('研究主题', 'topic'); input('Google Scholar 检索式', 'query');
      const sources = node('div', undefined, 'literature-sources'); sources.append(node('span', '检索来源（目前仅 Scholar 可执行）'));
      [['google-scholar', 'Google Scholar'], ['cnki', '知网'], ['wanfang', '万方'], ['web-of-science', 'Web of Science'], ['scopus', 'Scopus'], ['pubmed', 'PubMed']].forEach(([value, label]) => {
        const wrap = node('label', label); const check = node('input'); check.type = 'checkbox'; check.checked = config.sources.includes(value);
        check.onchange = () => { config.sources = check.checked ? [...config.sources, value] : config.sources.filter(source => source !== value); persistConfig(); };
        wrap.prepend(check); sources.append(wrap);
      });
      fields.append(sources);
      input('发表年份起', 'publicationYearFrom', 'number'); input('发表年份止', 'publicationYearTo', 'number');
      input('地域（需写入检索式才用于检索）', 'geography'); input('语言（供后续筛选）', 'language'); input('首批条数', 'limit', 'number');
      lines('研究类型（每行一项）', 'studyTypes'); lines('纳入规则（每行一项）', 'inclusion');
      lines('排除规则（每行一项）', 'exclusion'); lines('目标参数字段（每行一项）', 'targetFields');
      details.append(fields); box.append(details);
      if (config.sources.some(source => source !== 'google-scholar')) box.append(node('p', '配置含未接通来源：启动时会报错；如本次只做 Scholar 首批检索，请明确取消其他来源。', 'codex-error'));
    } else box.append(node('p', '先在本模块对话确认规则，再点“从对话整理规则”。AI 生成的是候选配置，需你核对后才会执行。', 'codex-status'));
    if (!t.literatureJob) box.append(node('p', '首次运行将自动创建 .venv 并安装最小依赖及 Chromium；若 Scholar 出现验证码，请在新开的浏览器中手动完成。', 'codex-status'));
    if (t.literatureJob) {
      const job = t.literatureJob;
      box.append(node('p', '状态：' + (job.message || job.stage || job.status) + (job.status === 'completed' ? ' · ' + job.count + ' 条待复核' : ''), 'codex-status'));
      if (Array.isArray(job.files) && job.files.length) {
        const links = node('div', undefined, 'literature-downloads');
        job.files.forEach(name => {
          const link = node('a', name === 'candidates.csv' ? '下载候选 CSV' : name === 'run_config.json' ? '下载运行配置' : '下载候选 JSON');
          link.href = '/api/literature/download?id=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(name);
          links.append(link);
        });
        box.append(links);
      }
      if (Array.isArray(job.events) && job.events.length > 1) {
        const details = node('details'); details.append(node('summary', '查看阶段记录'));
        details.append(node('pre', job.events.map(event => event.message).join('\n')));
        box.append(details);
      }
    }
    if (t.literatureError) box.append(node('p', t.literatureError, 'codex-error'));
    panel.append(box);
  }
  async function reply(module, messages) {
    const t = task(module.id);
    if (t.busy) throw new Error('文件上传或 Codex 任务正在进行');
    const executeRequested = t.executeOnce || t.execute;
    t.executeOnce = false;
    t.busy = true; t.error = ''; t.job = null; render();
    try {
      const sid = await session(module.id);
      const job = await request('/api/codex/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, module: { type: module.type, mode: module.mode }, messages, execute: executeRequested, model: t.model || null }) });
      saved[module.id].jobId = job.id; persist();
      await watch(module.id, job.id);
    } finally { t.busy = false; render(); }
  }
  async function prepareConfirmedExecution(id) {
    const t = task(id);
    if (t.busy) throw new Error('当前文件或 AI 任务尚未完成');
    if (t.backend !== 'codex') throw new Error('请先选择本机 Codex');
    const sid = await session(id);
    t.files = (await request('/api/codex/files?session=' + sid)).files;
    const mod = Store.getState().modules.find(item => item.id === id);
    if (!t.files.some(file => file.group === 'input')) { render(); return false; }
    if (mod?.type === 'calculation' && !t.files.some(file => /\.(py|r|jl|m|ipynb)$/i.test(file.name) && file.group === 'input')) throw new Error('请先上传计算代码');
    if (mod?.type === 'calculation' && !t.files.some(file => /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name) && file.group === 'input')) throw new Error('请先上传输入数据');
    t.execute = false;
    t.executeOnce = true;
    render();
    return true;
  }
  function cancelPreparedExecution(id) { task(id).executeOnce = false; render(); }
  async function runDirect(mod) {
    const t = task(mod.id);
    try {
      const ready = await prepareConfirmedExecution(mod.id);
      if (!ready) throw new Error('请先上传计算代码和输入数据');
      if (!t.files.some(file => file.group === 'input' && /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name))) throw new Error('请先上传输入数据');
      const mode = document.getElementById('conversation-mode');
      mode.value = 'ai'; mode.dispatchEvent(new Event('change'));
      if (!ModuleSpace.sendText('请直接运行本模块已上传的现有计算代码，读取已上传输入数据得到输出。不要修改代码或计算方法；若入口、依赖或运行方式不明确，先询问我。保存运行日志、输出文件和基本检查报告。')) throw new Error('当前模块无法发送执行请求');
      t.error = '';
    } catch (error) { cancelPreparedExecution(mod.id); t.error = error.message; render(); }
  }
  async function runAudit(mod) {
    const t = task(mod.id);
    try {
      const sid = await session(mod.id);
      t.files = (await request('/api/codex/files?session=' + sid)).files;
      if (!t.files.some(file => file.group === 'output')) throw new Error('还没有计算输出，请先完成计算');
      if (!root.TaskManager?.confirmedRules() && !t.files.some(file => file.group === 'reference')) throw new Error('请先讨论并确认核查原则，或上传已有核查标准。');
      const mode = document.getElementById('conversation-mode');
      mode.value = 'ai'; mode.dispatchEvent(new Event('change'));
      if (!ModuleSpace.sendText('请依据本模块已确认的核查原则和我上传的核查标准，检查计算结果。先列出所用原则版本、标准文件及适用条目；标准冲突或缺少判定依据时先问我。查看输出、代码、输入和日志，若有多次运行而我尚未指定，先问我核查哪一次。逐项给出通过、未通过或无法判断，以及数值证据和可能的问题位置。只读核查，不修改或重跑计算。')) throw new Error('当前模块无法发送核查请求');
      t.error = '';
    } catch (error) { t.error = error.message; render(); }
  }
  function discussAuditPrinciples(mod) {
    const mode = document.getElementById('conversation-mode');
    mode.value = 'ai'; mode.dispatchEvent(new Event('change'));
    task(mod.id).error = ModuleSpace.sendText('我们先讨论核查原则。请读取本任务已有的计算文件与上传的核查标准（如有），帮我明确核查对象与运行版本、检查指标、阈值或判定关系、抽样办法、通过与退回条件。区分我已经确认的条目和你提出的候选建议，缺少依据就询问。现在只讨论原则，不开始核查，也不宣称结果通过。') ? '' : '当前无法发送，请等待正在进行的任务完成，或先处理输入框中的文字。';
    render();
  }
  function returnToCalculation(auditModule) {
    const state = Store.getState();
    const calculation = state.modules.find(item => item.type === 'calculation');
    const finding = [...(auditModule.messages || [])].reverse().find(message => message.role === 'assistant');
    if (!calculation || !finding) { task(auditModule.id).error = '请先在核查对话中取得定位结果。'; render(); return; }
    Store.selectModule(calculation.id);
    const mode = document.getElementById('conversation-mode');
    mode.value = 'ai'; mode.dispatchEvent(new Event('change'));
    const input = document.getElementById('composer-input');
    input.value = '请根据以下核查发现讨论问题来源与修改方案，先不要改代码或执行。我会检查并确认修改规则：\n\n' + finding.text.slice(0, 3200);
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  function render() {
    const state = Store.getState();
    const mod = state.modules.find(m => m.id === state.activeModuleId);
    panel.hidden = !mod || !document.getElementById('records-view').hidden;
    if (panel.hidden) return;
    const t = task(mod.id);
    panel.replaceChildren();
    const row = node('div', undefined, 'codex-toolbar');
    const label = node('label', '模块助手 ');
    const backend = node('select'); backend.setAttribute('aria-label', '模块助手');
    [['codex', '本机 Codex（无需 API Key）'], ['api', 'API 对话']].forEach(([value, title]) => { const option = node('option', title); option.value = value; backend.append(option); });
    backend.value = t.backend; backend.disabled = t.busy;
    backend.onchange = () => { t.backend = backend.value; saved[mod.id] = { ...saved[mod.id], backend: t.backend }; persist(); render(); };
    label.append(backend); row.append(label);
    if (t.backend === 'codex') {
      if (mod.type === 'calculation') {
        const branchLabel = node('label', '计算路径 ');
        const branch = node('select'); branch.setAttribute('aria-label', '计算路径');
        const placeholder = node('option', '请选择'); placeholder.value = ''; branch.append(placeholder);
        [['direct', '直接计算'], ['modify', '修改计算']].forEach(([value, title]) => { const option = node('option', title); option.value = value; branch.append(option); });
        if (mod.mode && !['direct', 'modify'].includes(mod.mode)) { const old = node('option', '旧路径 · ' + mod.mode); old.value = mod.mode; branch.append(old); }
        branch.value = mod.mode || ''; branch.disabled = t.busy;
        branch.onchange = () => { Store.setModuleMode(mod.id, branch.value); render(); };
        branchLabel.append(branch); row.append(branchLabel);
      }
      if (mod.type === 'clean-data') {
        const mode = node('select'); mode.setAttribute('aria-label', 'Codex 工作模式');
        [['plan', '查看数据 / 拟方案'], ['execute', '执行已确认步骤']].forEach(([value, title]) => { const option = node('option', title); option.value = value; mode.append(option); });
        mode.value = t.execute ? 'execute' : 'plan'; mode.disabled = t.busy;
        mode.onchange = () => { t.execute = mode.value === 'execute'; };
        row.append(mode);
      }
      const status = node('span', checking ? '检查登录中…' : account?.loggedIn ? 'Codex 已登录' : 'Codex 未连接', 'codex-status'); row.append(status);
      const reconnect = node('button', '检查连接', 'quiet-button'); reconnect.type = 'button'; reconnect.disabled = checking; reconnect.onclick = check; row.append(reconnect);
      const modelLabel = node('label', '模型 ');
      const modelPicker = node('select'); modelPicker.setAttribute('aria-label', 'Codex 模型');
      const defaultOption = node('option', '默认 · ' + (account?.model || '检查连接后显示')); defaultOption.value = ''; modelPicker.append(defaultOption);
      (account?.models || []).forEach(item => { const option = node('option', item.displayName || item.model); option.value = item.model; modelPicker.append(option); });
      if (t.model && !(account?.models || []).some(item => item.model === t.model)) {
        const missing = node('option', t.model + '（当前不可用）'); missing.value = t.model; modelPicker.append(missing);
      }
      modelPicker.value = t.model;
      modelPicker.disabled = t.busy || checking || !account?.loggedIn;
      modelPicker.onchange = () => { t.model = modelPicker.value; saved[mod.id] = { ...saved[mod.id], model: t.model }; persist(); };
      modelLabel.append(modelPicker); row.append(modelLabel);
    }
    panel.append(row);
    if (mod.type === 'literature-mining') {
      literaturePanel(mod, t);
      if (t.backend === 'api') panel.append(node('p', 'API 对话只负责方案讨论；上方检索按钮由本地 Scholar 连接器执行。'));
      else if (account?.error) panel.append(node('p', account.error + '；Codex 对话可在终端运行 codex login 后检查连接。', 'codex-error'));
      return;
    }
    if (t.backend === 'api') { panel.append(node('p', 'API 模式提供文字指导；数据清洗的上传与执行需切换本机 Codex。')); return; }
    if (account?.error) panel.append(node('p', account.error + '；可在终端运行 codex login 后检查连接。', 'codex-error'));
    else if (account && !account.loggedIn) panel.append(node('p', '请在终端运行 codex login，用 ChatGPT 账号登录后检查连接。', 'codex-error'));
    if (!['clean-data', 'calculation', 'result-audit'].includes(mod.type)) {
      panel.append(node('p', mod.type === 'literature-mining'
        ? '文献挖掘执行状态：尚未接入自动检索、全文提取和文件交付。主题已足够形成首批检索方案；继续对话不会自动启动检索。'
        : '本模块可用 Codex 对话梳理方案与规则；当前不执行下载、计算或文件处理。'));
      if (t.busy) panel.append(node('p', 'Codex 正在回复…', 'codex-status'));
      if (t.error) panel.append(node('p', t.error, 'codex-error'));
      return;
    }
    const files = node('details', undefined, 'codex-attachments');
    files.open = t.filesOpen;
    const toggle = node('summary');
    toggle.setAttribute('aria-label', '显示或隐藏文件与结果');
    toggle.setAttribute('aria-expanded', String(files.open));
    toggle.setAttribute('aria-controls', 'codex-file-list');
    toggle.title = '点击查看已上传文件与处理结果';
    toggle.append(node('span', '文件与结果 · ' + t.files.length));
    const chevron = node('span', undefined, 'codex-chevron'); chevron.setAttribute('aria-hidden', 'true'); toggle.append(chevron);
    files.append(toggle);
    files.ontoggle = () => { t.filesOpen = files.open; toggle.setAttribute('aria-expanded', String(files.open)); };
    const fileRow = node('div', undefined, 'codex-toolbar');
    if (mod.type !== 'result-audit') {
      const input = node('input'); input.type = 'file'; input.multiple = true;
      input.accept = mod.type === 'calculation' ? '.py,.r,.R,.jl,.m,.ipynb,.csv,.tsv,.xlsx,.xls,.json,.txt' : '.csv,.tsv,.xlsx,.xls,.json,.txt';
      input.disabled = t.busy;
      input.setAttribute('aria-label', mod.type === 'calculation' ? '上传计算代码和输入数据' : '上传清洗原始文件');
      input.onchange = () => upload(mod.id, Array.from(input.files)); fileRow.append(input);
    }
    const refreshButton = node('button', '刷新文件', 'quiet-button'); refreshButton.type = 'button'; refreshButton.disabled = t.busy; refreshButton.onclick = () => refresh(mod.id); fileRow.append(refreshButton);
    if (mod.type === 'calculation' && mod.mode === 'direct') {
      const start = node('button', '运行现有代码', 'primary-button'); start.type = 'button'; start.disabled = t.busy; start.onclick = () => runDirect(mod); fileRow.append(start);
    }
    if (mod.type === 'calculation' && mod.mode === 'modify') fileRow.append(node('span', '先讨论方案，在上方确认修改规则后执行。', 'codex-status'));
    if (mod.type === 'result-audit') {
      const discuss = node('button', '讨论核查原则', 'quiet-button'); discuss.type = 'button'; discuss.disabled = t.busy; discuss.onclick = () => discussAuditPrinciples(mod); fileRow.append(discuss);
      const reference = node('input'); reference.type = 'file'; reference.multiple = true; reference.hidden = true;
      reference.accept = '.md,.txt,.pdf,.docx,.csv,.tsv,.xlsx,.xls,.json';
      reference.setAttribute('aria-label', '上传核查标准或参考文件');
      reference.onchange = () => upload(mod.id, Array.from(reference.files), 'reference');
      const uploadStandard = node('button', '上传核查标准', 'quiet-button'); uploadStandard.type = 'button'; uploadStandard.disabled = t.busy; uploadStandard.onclick = () => reference.click(); fileRow.append(uploadStandard, reference);
      const start = node('button', '核查计算结果', 'primary-button'); start.type = 'button'; start.disabled = t.busy; start.onclick = () => runAudit(mod); fileRow.append(start);
      const back = node('button', '带定位结果返回计算', 'quiet-button'); back.type = 'button'; back.disabled = t.busy; back.onclick = () => returnToCalculation(mod); fileRow.append(back);
    }
    if (t.busy && t.job?.id) {
      const stop = node('button', '停止任务', 'quiet-button'); stop.type = 'button';
      stop.onclick = async () => { try { await request('/api/codex/cancel?id=' + t.job.id, { method: 'POST' }); } catch (error) { t.error = error.message; render(); } };
      row.append(stop);
    }
    panel.append(fileRow);
    if (mod.type === 'result-audit') panel.append(node('p', '先讨论并在上方确认核查原则，或直接上传已有标准；再核查结果、讨论定位。每个标准文件上限 20MB。', 'codex-status'));
    const list = node('div', undefined, 'codex-files');
    list.id = 'codex-file-list';
    list.append(node('p', mod.type === 'result-audit' ? '与计算模块共享输入及各次输出；点击文件名下载。' : '上传文件与本次结果；点击文件名下载。每个上传文件上限 20MB。'));
    if (!t.files.length) list.append(node('p', mod.type === 'result-audit' ? '还没有计算文件，请先在计算模块运行。' : '还没有文件，请先选择原始数据。'));
    t.files.forEach(file => {
      const displayName = file.name.split('/').pop().replace(/^[0-9a-f]{8}-/, '');
      const link = node('a', (file.group === 'input' ? '原始 · ' : file.group === 'reference' ? '核查标准 · ' : '结果 · ') + displayName + ' · ' + Math.ceil(file.size / 1024) + 'KB');
      link.title = file.name;
      link.href = '/api/codex/download?session=' + saved[mod.id]?.sessionId + '&group=' + file.group + '&name=' + encodeURIComponent(file.name); list.append(link);
    });
    files.append(list); fileRow.append(files);
    if (t.busy) panel.append(node('p', t.job ? 'Codex 正在处理…' : '上传或启动中…', 'codex-status'));
    if (t.job?.events.length) { const log = node('details'); log.open = t.logOpen; log.ontoggle = () => { t.logOpen = log.open; }; log.append(node('summary', '执行进度')); log.append(node('pre', t.job.events.join('\n'))); panel.append(log); }
    if (t.error) panel.append(node('p', t.error, 'codex-error'));
  }
  root.CodexUI = { render, reply, prepareConfirmedExecution, cancelPreparedExecution, useCodex: mod => !!mod && task(mod.id).backend === 'codex', busy: id => task(id).busy };
  function closeFiles() {
    const files = panel.querySelector('.codex-attachments[open]');
    if (!files) return;
    const id = Store.getState().activeModuleId;
    if (id) task(id).filesOpen = false;
    files.open = false;
  }
  document.addEventListener('pointerdown', event => {
    const files = panel.querySelector('.codex-attachments[open]');
    if (files && !files.contains(event.target)) closeFiles();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const files = panel.querySelector('.codex-attachments[open]');
      if (files) { closeFiles(); files.querySelector('summary').focus(); }
    }
  });
  Store.subscribe(render);
  render();
  check();
  Object.keys(saved).forEach(id => {
    if (saved[id].sessionId) refresh(id);
    if (saved[id].jobId) watch(id, saved[id].jobId).catch(() => {});
    if (saved[id].literatureJobId) watchLiterature(id, saved[id].literatureJobId).catch(() => {});
  });
})(window);
