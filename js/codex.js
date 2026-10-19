/* Local Codex connection and task files for the cleaning module. */
(function (root) {
  'use strict';
  const tasks = {};
  const key = 'research_codex_tasks_v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_) {}
  let account = null;
  let checking = false;
  let loginBusy = false;
  let loginTimer = null;
  let loginNotice = '';
  let downloadModuleId = null;
  let downloadBasis = null;
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem('fa_codex_connection_v1')) || {}; } catch (_) {}
  const backendPicker = document.getElementById('ai-backend');
  const modelPicker = document.getElementById('codex-model');
  const loginButton = document.getElementById('codex-login');
  const refreshButton = document.getElementById('codex-refresh');
  const connectionStatus = document.getElementById('codex-status');
  const loginLink = document.getElementById('codex-login-link');
  const panel = document.createElement('section');
  panel.className = 'codex-panel';
  panel.hidden = true;
  document.getElementById('module-space').before(panel);
  function persist() { try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {} }
  function task(id) {
    if (!tasks[id]) tasks[id] = { files: [], busy: false, backend: saved[id]?.backend || preferences.backend || 'codex', model: saved[id]?.model ?? preferences.model ?? '', execute: false, executeOnce: false, error: '', job: null, filesOpen: false, logOpen: false,
      literatureConfig: saved[id]?.literatureConfig || null, literatureJob: null, literatureBusy: false, literatureError: '',
      literatureUntil: saved[id]?.literatureUntil || 'discover', literatureJobs: null, literatureJobsTried: false, literatureJobsLoading: false, literatureJobsError: '',
      literatureConfirmJob: null, literatureConfirmDrafts: null };
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
    checking = false;
    if (account?.loggedIn) { loginNotice = ''; loginLink.hidden = true; if (loginTimer) clearInterval(loginTimer); loginTimer = null; }
    render();
  }
  function renderConnection() {
    const state = Store.getState();
    const mod = state.modules.find(item => item.id === state.activeModuleId);
    const t = mod ? task(mod.id) : preferences;
    backendPicker.value = t.backend || 'codex'; backendPicker.disabled = !!t.busy;
    modelPicker.replaceChildren();
    const initial = node('option', '账号默认 · ' + (account?.model || '登录后显示')); initial.value = ''; modelPicker.append(initial);
    (account?.models || []).forEach(item => { const option = node('option', item.displayName || item.model); option.value = item.model; modelPicker.append(option); });
    if (t.model && !(account?.models || []).some(item => item.model === t.model)) { const option = node('option', t.model + '（当前不可用，请重新选择）'); option.value = t.model; option.disabled = true; modelPicker.append(option); }
    modelPicker.value = t.model || ''; modelPicker.disabled = !!t.busy || checking || !account?.loggedIn;
    loginButton.textContent = account?.loggedIn ? '本机 Codex 已连接' : '登录本机 Codex'; loginButton.disabled = loginBusy || !!t.busy;
    refreshButton.disabled = checking;
    const connectionError = account?.error?.includes('workspace routing discovery timed out') ? 'Codex 工作区连接超时，请检查本机网络后重试。' : account?.error;
    connectionStatus.textContent = checking ? '检查连接中…' : loginNotice || connectionError || (account?.loggedIn ? '本机 Codex 已登录 · ' + (account.models || []).length + ' 个模型' : '未连接，请先安装 Codex CLI 并点击登录');
    document.querySelectorAll('[data-api-settings]').forEach(item => { item.hidden = backendPicker.value !== 'api'; });
  }
  function saveConnection() {
    const id = Store.getState().activeModuleId;
    preferences = { backend: backendPicker.value, model: modelPicker.value };
    if (id) { Object.assign(task(id), preferences); saved[id] = { ...saved[id], ...preferences }; persist(); }
    try { localStorage.setItem('fa_codex_connection_v1', JSON.stringify(preferences)); } catch (_) {}
    render(); ModuleSpace.render();
  }
  backendPicker.onchange = saveConnection; modelPicker.onchange = saveConnection; refreshButton.onclick = check;
  loginButton.onclick = async () => {
    if (loginBusy) return;
    loginBusy = true; renderConnection();
    const popup = root.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const data = await request('/api/codex/login', { method: 'POST' });
      backendPicker.value = 'codex'; saveConnection();
      if (data.loggedIn) { if (popup) popup.close(); await check(); return; }
      const url = new URL(data.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('登录地址无法识别');
      loginLink.href = url.href; loginLink.hidden = false;
      if (popup) popup.location.href = url.href;
      loginNotice = '请在官方页面完成登录；窗口被拦截时点击登录链接。';
      if (loginTimer) clearInterval(loginTimer);
      let attempts = 0;
      loginTimer = setInterval(() => { if (++attempts > 120) { clearInterval(loginTimer); loginTimer = null; loginNotice = '等待已结束，请检查连接或重新登录。'; renderConnection(); return; } if (!checking) void check(); }, 3000);
    } catch (error) { if (popup) popup.close(); loginNotice = '无法登录：' + error.message; }
    finally { loginBusy = false; renderConnection(); }
  };
  async function upload(id, files, group = 'input') {
    const t = task(id); if (t.busy) return;
    t.busy = true; t.error = ''; render();
    try {
      const sid = await session(id);
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ' 超过 20MB');
        const previousNames = new Set(t.files.map(item => item.name));
        t.files = (await request('/api/codex/upload?session=' + sid + '&group=' + group + '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file })).files;
        if (group === 'input' && saved[id]?.inputBatch) {
          saved[id].inputBatch.names.push(...t.files.filter(item => item.group === 'input' && !previousNames.has(item.name)).map(item => item.name));
          persist();
        }
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
  function literatureCompletedMessage(job) {
    const base = '首批候选检索已保存 ' + job.count + ' 条待复核记录；这不是已纳入文献，也未提取全文。可在文献检索区下载清单。';
    const extra = literatureDeliverableSummary(job);
    return extra ? base + extra : base;
  }
  function literatureDeliverableSummary(job) {
    const files = Array.isArray(job.files) ? job.files : [];
    if (files.includes('export/literature.xlsx')) return '本次已导出文献表与参数明细表（CSV+Excel）；去重、校验与待审核结果见下载区。';
    if (files.includes('validation/validation.json')) return '已完成参数校验；待审核清单与阻断明细见下载区。';
    if (files.some(name => /^extraction\/[^/]+\.json$/.test(name))) return '已完成参数提取；结果与校验报告见下载区。';
    if (files.includes('fulltext/status.json')) return '已记录全文获取状态（含“待补充”项）；明细见下载区。';
    if (files.includes('dedupe/dedupe.json')) return '已完成跨来源去重；疑似重复组未静默合并，见下载区待审清单。';
    return '';
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
          const stamp = job.id + ':' + job.status + ':' + (job.stage || '') + ':' + (Array.isArray(job.events) ? job.events.length : 0);
          if (saved[id]?.literatureDelivered !== stamp) {
            const text = job.status === 'completed' ? literatureCompletedMessage(job)
              : job.status === 'needs_attention' && job.stage === 'awaiting_confirmation'
                ? '提取前需由研究者确认参数字段含义与单位：请在文献检索区核对字段并点击“确认并继续提取”。'
              : job.status === 'needs_attention' ? 'Google Scholar 需要人工验证。请在检索浏览器完成后点击“重新检索”。'
              : '文献检索' + (job.status === 'cancelled' ? '已停止' : '未完成') + '：' + (job.error || job.message);
            Store.appendMessage(id, text, 'system');
            saved[id].literatureDelivered = stamp; persist();
          }
          t.literatureJobsTried = false;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      t.literatureError = '';
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  function applyLiteratureJob(mod, job) {
    const t = task(mod.id);
    t.literatureJob = job;
    if (job?.id) saved[mod.id] = { ...saved[mod.id], literatureJobId: job.id };
    persist();
  }
  async function startLiterature(mod) {
    const t = task(mod.id);
    if (!t.literatureConfig) { t.literatureError = '请先从对话整理运行配置并核对'; render(); return; }
    const config = { ...t.literatureConfig, extraction: { ...t.literatureConfig.extraction,
      model: t.model || account?.model || t.literatureConfig.extraction?.model || null } };
    if (saved[mod.id]?.literatureSource !== literatureSource(mod)) { t.literatureError = '对话或已批准文档有更新，请重新整理规则后再检索'; render(); return; }
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const resumeCurrent = t.literatureJob?.status === 'needs_attention' && t.literatureJob.stage !== 'awaiting_confirmation'
        && sameLiteratureConfig(t.literatureJob.config, config);
      const body = { config, resumeCurrent };
      if (t.literatureUntil && t.literatureUntil !== 'discover') body.until = t.literatureUntil;
      const job = await request('/api/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      t.literatureJob = job;
      t.literatureConfig = config;
      saved[mod.id] = { ...saved[mod.id], literatureJobId: job.id, literatureConfig: config };
      persist();
      await watchLiterature(mod.id, job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function continueLiterature(mod) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可继续的检索任务'; render(); return; }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const body = { id: job.id };
      if (t.literatureUntil && t.literatureUntil !== 'discover') body.until = t.literatureUntil;
      const next = await request('/api/literature/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, next.id || job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function confirmLiteratureFields(mod) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可确认的检索任务'; render(); return; }
    const fields = (t.literatureConfirmDrafts || []).map(draft => ({ key: String(draft.key || '').trim(), label: String(draft.label || '').trim(),
      meaning: String(draft.meaning || '').trim(), unit: String(draft.unit || '').trim(), valueType: draft.valueType || 'text', required: draft.required === true }));
    if (!fields.length) { t.literatureError = '没有可确认的参数字段；请先在“目标参数字段”中填写后再回到本关口'; render(); return; }
    if (fields.some(field => !field.key)) { t.literatureError = '每个参数字段都需要填写 key（字段标识）后才能确认'; render(); return; }
    if (new Set(fields.map(field => field.key)).size !== fields.length) { t.literatureError = '参数字段 key 不能重复'; render(); return; }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const next = await request('/api/literature/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, confirmations: { fields } }) });
      t.literatureConfirmJob = null; t.literatureConfirmDrafts = null;
      applyLiteratureJob(mod, next);
      Store.appendMessage(mod.id, '已记录研究者确认的参数字段（' + fields.length + ' 项），继续执行提取。', 'system');
      await watchLiterature(mod.id, next.id || job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function loadLiteratureJobs(mod, options = {}) {
    const t = task(mod.id);
    if (t.literatureJobsLoading) return;
    t.literatureJobsLoading = true; t.literatureJobsTried = true;
    try {
      const data = await request('/api/literature/jobs?limit=20');
      t.literatureJobs = Array.isArray(data.jobs) ? data.jobs : [];
      t.literatureJobsError = '';
    } catch (error) {
      t.literatureJobs = t.literatureJobs || [];
      t.literatureJobsError = options.silent ? '' : error.message;
    }
    finally { t.literatureJobsLoading = false; render(); }
  }
  function attachLiteratureJob(mod, job) {
    const t = task(mod.id);
    if (!job?.id) return;
    t.literatureError = '';
    applyLiteratureJob(mod, job);
    render();
    if (job.status === 'running') watchLiterature(mod.id, job.id).catch(() => {});
  }
  function literatureSource(mod) {
    const entries = (mod.messages || []).filter(message => message.role === 'user' || message.role === 'assistant');
    return JSON.stringify({ messages: entries.map(message => [message.id, message.at]),
      approvedDoc: mod.doc?.status === 'approved' ? [mod.doc.content, mod.doc.approvedAt] : null });
  }
  const LITERATURE_CONFIG_KEYS = ['topic', 'query', 'sources', 'publicationYearFrom', 'publicationYearTo', 'geography', 'language',
    'studyTypes', 'inclusion', 'exclusion', 'targetFields', 'limit'];
  const LITERATURE_CONFIG_EXTRA_KEYS = ['batch', 'fieldDefinitions', 'templates', 'fulltext', 'extraction', 'limits'];
  function literatureConfigKey(config, keys = LITERATURE_CONFIG_KEYS) {
    if (!config) return '';
    return JSON.stringify(keys.map(key => config[key] ?? null));
  }
  function sameLiteratureConfig(one, other) {
    if (!one || !other) return false;
    const keys = [...LITERATURE_CONFIG_KEYS, ...LITERATURE_CONFIG_EXTRA_KEYS.filter(key => one[key] !== undefined && other[key] !== undefined)];
    return literatureConfigKey(one, keys) === literatureConfigKey(other, keys);
  }
  function parseLiteratureConfig(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 未返回运行配置；请重试或手动填写');
    const config = JSON.parse(raw.slice(start, end + 1));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AI 返回的配置格式无效');
    if (!Array.isArray(config.sources)) throw new Error('AI 未明确返回检索来源，请重新整理规则');
    const parsed = {
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
    ['batch', 'templates', 'fulltext', 'extraction', 'limits'].forEach(key => {
      if (config[key] && typeof config[key] === 'object' && !Array.isArray(config[key])) parsed[key] = config[key];
    });
    if (Array.isArray(config.fieldDefinitions) && config.fieldDefinitions.every(field => field && typeof field === 'object' && !Array.isArray(field))) {
      parsed.fieldDefinitions = config.fieldDefinitions;
    }
    return parsed;
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
        body: JSON.stringify({ sessionId: sid, messages, model: t.model || account?.model, approvedDoc: mod.doc?.status === 'approved' ? mod.doc.content : '' }) });
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
  const LITERATURE_STAGE_ORDER = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];
  const LITERATURE_STAGE_LABELS = { 'queued': '排队中', 'environment': '准备环境', 'browser': '启动浏览器', 'search': '检索候选', 'save': '保存候选',
    'dedupe': '跨来源去重', 'fulltext': '获取全文', 'extraction': '提取参数', 'extract': '提取参数', 'validation': '校验参数', 'validate': '校验参数',
    'export': '导出两表', 'verification': '等待人工验证', 'awaiting_confirmation': '等待确认字段',
    'completed': '已完成', 'failed': '失败', 'cancelled': '已停止', 'interrupted': '已中断', 'running': '进行中' };
  const LITERATURE_STAGE_STATES = { 'pending': '待运行', 'running': '进行中', 'done': '已完成', 'failed': '失败', 'skipped': '已跳过' };
  const LITERATURE_COUNTER_LABELS = { 'candidates': '候选', 'uniqueGroups': '去重组', 'fulltextFetched': '已获取全文', 'extractedPapers': '已提取论文', 'parameterRows': '参数行' };
  const LITERATURE_UNTIL_OPTIONS = [['discover', '仅首批检索'], ['dedupe', '续跑到去重'], ['fulltext', '续跑到全文获取'],
    ['extract', '续跑到参数提取'], ['validate', '续跑到校验'], ['export', '完整流水线']];
  const LITERATURE_STATUS_LABELS = { 'running': '进行中', 'completed': '已完成', 'needs_attention': '需要人工', 'failed': '失败', 'cancelled': '已停止' };
  const LITERATURE_FILE_LABELS = { 'run_config.json': '运行配置（冻结）', 'candidates.json': '候选清单 JSON（累计）', 'candidates.csv': '候选清单 CSV（累计）',
    'dedupe/dedupe.json': '去重结果 JSON', 'dedupe/dedupe.csv': '去重结果 CSV', 'fulltext/status.json': '全文获取状态',
    'extraction/check_report.json': '提取校验报告', 'validation/validation.json': '校验结果 JSON', 'validation/validation.md': '待审核清单',
    'export/literature.csv': '文献表 CSV', 'export/literature.xlsx': '文献表 Excel', 'export/parameters.csv': '参数明细表 CSV',
    'export/parameters.xlsx': '参数明细表 Excel', 'export/export_report.md': '导出报告' };
  const LITERATURE_FILE_GROUPS = [['dedupe', '去重产物'], ['fulltext', '全文产物'], ['extraction', '提取产物'], ['validation', '校验产物'], ['export', '导出产物']];
  function literatureStageLabel(stage) { return LITERATURE_STAGE_LABELS[stage] || String(stage || ''); }
  function literatureFileLabel(name) {
    if (LITERATURE_FILE_LABELS[name]) return LITERATURE_FILE_LABELS[name];
    let match = name.match(/^fulltext\/files\/(.+)\.(pdf|txt)$/);
    if (match) return '全文 · ' + match[1] + (match[2] === 'pdf' ? '（PDF）' : '（文本）');
    match = name.match(/^extraction\/inputs\/(.+)\.json$/);
    if (match) return '提取输入包 · ' + match[1];
    match = name.match(/^extraction\/(.+)\.json$/);
    if (match) return '提取结果 · ' + match[1];
    return name;
  }
  function literatureFileGroups(files) {
    const groups = [{ key: '', label: '检索与配置', files: [] }];
    LITERATURE_FILE_GROUPS.forEach(([key, label]) => groups.push({ key, label, files: [] }));
    files.forEach(name => {
      const known = LITERATURE_FILE_GROUPS.find(([key]) => name.startsWith(key + '/'));
      groups[known ? groups.findIndex(group => group.key === known[0]) : 0].files.push(name);
    });
    return groups.filter(group => group.files.length);
  }
  function literatureDeliverables(job) {
    const files = (Array.isArray(job.files) ? job.files : []).filter(name => typeof name === 'string');
    if (!files.length) return null;
    const box = node('div', undefined, 'literature-deliverables');
    literatureFileGroups(files).forEach(group => {
      const section = node('div', undefined, 'literature-deliverable-group');
      section.append(node('span', group.label + ' · ' + group.files.length + ' 个', 'literature-deliverable-title'));
      const list = node('div', undefined, 'literature-deliverable-list');
      const collapsed = group.files.length > 8;
      const link = name => {
        const anchor = node('a', literatureFileLabel(name));
        anchor.href = '/api/literature/download?id=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(name);
        anchor.title = name;
        return anchor;
      };
      (collapsed ? group.files.slice(0, 6) : group.files).forEach(name => list.append(link(name)));
      if (collapsed) {
        const more = node('details', undefined, 'literature-deliverable-more');
        more.append(node('summary', '展开其余 ' + (group.files.length - 6) + ' 个文件'));
        const inner = node('div', undefined, 'literature-deliverable-list');
        group.files.slice(6).forEach(name => inner.append(link(name)));
        more.append(inner); list.append(more);
      }
      section.append(list); box.append(section);
    });
    return box;
  }
  function literatureStageBar(job) {
    if (!job || !job.stages || typeof job.stages !== 'object') return null;
    const bar = node('div', undefined, 'literature-stages');
    LITERATURE_STAGE_ORDER.forEach(stage => {
      const state = LITERATURE_STAGE_STATES[job.stages[stage]] ? job.stages[stage] : 'pending';
      const item = node('span', undefined, 'literature-stage is-' + state);
      item.append(node('span', LITERATURE_STAGE_LABELS[stage] || stage));
      item.append(node('span', LITERATURE_STAGE_STATES[state], 'literature-stage-state'));
      bar.append(item);
    });
    const meta = [];
    if (job.resumeStage) meta.push('下一阶段：' + literatureStageLabel(job.resumeStage));
    if (job.until) meta.push('本次运行到：' + literatureStageLabel(job.until));
    if (job.counters && typeof job.counters === 'object') {
      Object.keys(job.counters).forEach(key => {
        if (typeof job.counters[key] === 'number') meta.push((LITERATURE_COUNTER_LABELS[key] || key) + ' ' + job.counters[key]);
      });
    }
    if (meta.length) bar.append(node('span', meta.join(' · '), 'literature-stage-meta'));
    return bar;
  }
  function literatureConfirmFields(t, job) {
    const sources = [job?.config || {}, t.literatureConfig || {}];
    for (const source of sources) {
      if (Array.isArray(source.fieldDefinitions) && source.fieldDefinitions.length) {
        return source.fieldDefinitions.map(field => ({ key: String(field?.key ?? ''), label: String(field?.label ?? field?.key ?? ''),
          meaning: String(field?.meaning ?? ''), unit: String(field?.unit ?? ''), valueType: String(field?.valueType || 'text'), required: field?.required === true }));
      }
    }
    for (const source of sources) {
      if (Array.isArray(source.targetFields) && source.targetFields.length) {
        return source.targetFields.map(field => ({ key: String(field), label: String(field), meaning: '', unit: '', valueType: 'text', required: false }));
      }
    }
    return [];
  }
  function literatureConfirmForm(mod, t, job) {
    const box = node('div', undefined, 'literature-confirm');
    box.append(node('p', '提取前需研究者确认参数字段的含义与单位：AI 建议不作为已确认规则，确认后才进入参数提取（确认记录写入任务目录）。'));
    if (t.literatureConfirmJob !== job.id) { t.literatureConfirmJob = job.id; t.literatureConfirmDrafts = literatureConfirmFields(t, job); }
    const drafts = t.literatureConfirmDrafts || [];
    if (!drafts.length) {
      box.append(node('p', '没有可确认的字段：请先在“目标参数字段”中填写字段（每行一项），回到本关口再确认。', 'codex-status'));
      return box;
    }
    const fields = node('div', undefined, 'literature-confirm-fields');
    drafts.forEach(draft => {
      const cell = node('div', undefined, 'literature-confirm-row');
      [['key', '字段 key'], ['label', '标签'], ['meaning', '含义'], ['unit', '单位']].forEach(([key, title]) => {
        const wrap = node('label', title); const field = node('input'); field.type = 'text';
        field.value = draft[key] ?? ''; field.disabled = t.literatureBusy;
        field.oninput = () => { draft[key] = field.value; };
        wrap.append(field); cell.append(wrap);
      });
      const typeWrap = node('label', '类型');
      const type = node('select');
      const types = ['text', 'number'].concat(['text', 'number'].includes(draft.valueType) ? [] : [draft.valueType]);
      types.forEach(value => { const option = node('option', value === 'number' ? '数值' : value === 'text' ? '文本' : value); option.value = value; type.append(option); });
      type.value = draft.valueType; type.disabled = t.literatureBusy;
      type.onchange = () => { draft.valueType = type.value; };
      typeWrap.append(type); cell.append(typeWrap);
      const requiredWrap = node('label', '必填');
      const required = node('input'); required.type = 'checkbox'; required.checked = draft.required === true; required.disabled = t.literatureBusy;
      required.onchange = () => { draft.required = required.checked; };
      requiredWrap.prepend(required); cell.append(requiredWrap);
      fields.append(cell);
    });
    box.append(fields);
    const actions = node('div', undefined, 'literature-confirm-actions');
    const confirm = node('button', t.literatureBusy ? '提交中…' : '确认并继续提取', 'primary-button');
    confirm.type = 'button'; confirm.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
    confirm.onclick = () => confirmLiteratureFields(mod);
    actions.append(confirm); box.append(actions);
    return box;
  }
  function literatureHistory(mod, t) {
    if (!t.literatureJobs && !t.literatureJobsTried && !t.literatureJobsLoading) void loadLiteratureJobs(mod, { silent: true });
    const box = node('details', undefined, 'literature-history');
    box.append(node('summary', '历史任务（刷新后仍可找回）' + (Array.isArray(t.literatureJobs) ? ' · ' + t.literatureJobs.length : '')));
    const head = node('div', undefined, 'literature-history-head');
    const refresh = node('button', t.literatureJobsLoading ? '刷新中…' : '刷新任务列表', 'quiet-button');
    refresh.type = 'button'; refresh.disabled = t.literatureJobsLoading;
    refresh.onclick = () => loadLiteratureJobs(mod);
    head.append(refresh); box.append(head);
    if (!Array.isArray(t.literatureJobs)) box.append(node('p', '正在读取历史任务…', 'codex-status'));
    else if (!t.literatureJobs.length) box.append(node('p', '暂无历史任务记录。', 'codex-status'));
    else {
      const list = node('div', undefined, 'literature-history-list');
      t.literatureJobs.forEach(job => {
        const row = node('div', undefined, 'literature-history-row' + (job.id === t.literatureJob?.id ? ' is-current' : ''));
        row.append(node('span', String(job.id || '').slice(0, 8), 'literature-history-id'));
        row.append(node('span', (LITERATURE_STATUS_LABELS[job.status] || job.status || '') + (job.stage ? ' · ' + literatureStageLabel(job.stage) : ''), 'literature-history-status'));
        row.append(node('span', String(job.message || '').slice(0, 60), 'literature-history-message'));
        const open = node('button', '查看', 'quiet-button'); open.type = 'button'; open.disabled = t.literatureBusy || t.busy;
        open.onclick = () => attachLiteratureJob(mod, job);
        row.append(open); list.append(row);
      });
      box.append(list);
    }
    if (t.literatureJobsError) box.append(node('p', '历史任务列表读取失败：' + t.literatureJobsError, 'codex-error'));
    return box;
  }
  function literaturePanel(mod, t, container = panel) {
    const box = node('div', undefined, 'literature-connector');
    box.append(node('p', '对话确认规则 → 核对运行配置 → 分阶段执行：候选检索、跨来源去重、全文获取、参数提取、校验、导出。当前仅 Google Scholar 已接通；全文提取前需要你确认参数字段含义与单位。'));
    const row = node('div', undefined, 'codex-toolbar literature-toolbar');
    const prepare = node('button', t.literatureBusy ? '处理中…' : '从对话整理规则', 'quiet-button');
    prepare.type = 'button'; prepare.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy(); prepare.onclick = () => prepareLiterature(mod); row.append(prepare);
    if (!t.literatureConfig) {
      const manual = node('button', '手动填写', 'quiet-button'); manual.type = 'button'; manual.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      manual.onclick = () => manualLiterature(mod); row.append(manual);
    }
    const job = t.literatureJob;
    const awaitingConfirm = !!job && job.status === 'needs_attention' && job.stage === 'awaiting_confirmation';
    const start = node('button', job?.status === 'needs_attention' && !awaitingConfirm ? '验证后重新检索' : '确认配置并检索', 'primary-button');
    start.type = 'button'; start.disabled = t.literatureBusy || !!root.LiteratureUI?.isBusy() || t.busy || !t.literatureConfig;
    if (awaitingConfirm) start.title = '当前任务停在字段确认关口；本按钮发起一次新检索，继续原任务请用下方“确认并继续提取”。';
    start.onclick = () => startLiterature(mod); row.append(start);
    if (job?.status === 'running') {
      const stop = node('button', '停止', 'quiet-button'); stop.type = 'button';
      stop.onclick = async () => {
        try { t.literatureJob = await request('/api/literature/cancel?id=' + encodeURIComponent(t.literatureJob.id), { method: 'POST' }); }
        catch (error) { t.literatureError = error.message; }
        render();
      };
      row.append(stop);
    }
    const canAdvance = !!job && !!job.resumeStage && ['completed', 'failed', 'needs_attention'].includes(job.status)
      && !(job.status === 'needs_attention' && (job.stage === 'verification' || job.stage === 'awaiting_confirmation'));
    if (canAdvance) {
      const label = job.status === 'completed' ? '继续下一阶段' : job.status === 'failed' ? (job.stage === 'interrupted' ? '继续中断的任务' : '重试当前阶段') : '继续';
      const advance = node('button', label, 'quiet-button'); advance.type = 'button'; advance.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      advance.title = '从下一个未完成阶段继续；缺省运行到下一个人工关口或流水线末尾。';
      advance.onclick = () => continueLiterature(mod); row.append(advance);
    }
    const untilWrap = node('label', '运行到');
    const until = node('select'); until.setAttribute('aria-label', '本次运行到');
    LITERATURE_UNTIL_OPTIONS.forEach(([value, title]) => { const option = node('option', title); option.value = value; until.append(option); });
    until.value = t.literatureUntil || 'discover'; until.disabled = t.literatureBusy || t.busy;
    until.onchange = () => { t.literatureUntil = until.value; saved[mod.id] = { ...saved[mod.id], literatureUntil: t.literatureUntil }; persist(); };
    untilWrap.append(until); row.append(untilWrap);
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
    if (!job) box.append(node('p', '首次运行将自动创建 .venv 并安装最小依赖及 Chromium；若 Scholar 出现验证码，请在新开的浏览器中手动完成。', 'codex-status'));
    if (job) {
      box.append(node('p', '状态：' + (job.message || literatureStageLabel(job.stage) || job.status) + (job.status === 'completed' ? ' · ' + job.count + ' 条待复核' : ''), 'codex-status'));
      const stages = literatureStageBar(job);
      if (stages) box.append(stages);
      if (awaitingConfirm) box.append(literatureConfirmForm(mod, t, job));
      const deliverables = literatureDeliverables(job);
      if (deliverables) box.append(deliverables);
      if (Array.isArray(job.events) && job.events.length > 1) {
        const details = node('details'); details.append(node('summary', '查看阶段记录'));
        details.append(node('pre', job.events.map(event => event.message).join('\n')));
        box.append(details);
      }
    }
    box.append(literatureHistory(mod, t));
    if (t.literatureError) box.append(node('p', t.literatureError, 'codex-error'));
    container.append(box);
  }
  async function reply(module, messages) {
    const t = task(module.id);
    if (t.busy) throw new Error('文件上传或 Codex 任务正在进行');
    const executeRequested = t.executeOnce || t.execute;
    t.executeOnce = false;
    t.busy = true; t.error = ''; t.job = null; render();
    try {
      const sid = await session(module.id);
      const batch = saved[module.id]?.inputBatch;
      if (module.type === 'clean-data' && batch) messages = [{ role: 'user', text: '当前下载交接批次（来源信息，不替代本模块的清洗规则）：\n仅处理以下当前输入文件，其他 input 文件为历史保留，不自动合并：\n' + batch.names.join('\n') + '\n获取依据：' + batch.label + '\n' + batch.text.slice(0, 1500) }, ...messages];
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
  function basisForDownload(mod, sourceType) {
    if (!sourceType && mod.doc?.status === 'approved') return { text: mod.doc.content, label: '已审核下载方案', sourceType: 'doc' };
    if (sourceType !== 'doc') {
      const rules = root.TaskManager?.rulesForModule(mod.id);
      if (rules?.text) return { text: rules.text, label: '已确认下载规则 v' + rules.version, sourceType: 'rules' };
    }
    if (mod.doc?.status === 'approved') return { text: mod.doc.content, label: '已审核下载方案', sourceType: 'doc' };
    return null;
  }
  function openDownload(mod, basis) {
    const t = task(mod.id);
    if (t.busy) return false;
    basis = basis || basisForDownload(mod);
    if (!basis?.text) { t.error = '请先确认上方下载规则，或审核下载方案，再开始下载。'; render(); return false; }
    downloadModuleId = mod.id; downloadBasis = basis;
    document.getElementById('download-basis').textContent = basis.label + '\n' + basis.text;
    const previous = saved[mod.id]?.download?.sources;
    const urls = basis.text.match(/https?:\/\/[^\s<>"\]\)]+/g) || [];
    document.getElementById('download-sources').value = previous ? previous.map(source => source.url + (source.name ? ' | ' + source.name : '')).join('\n') : urls.slice(0, 5).join('\n');
    document.getElementById('download-status').textContent = '请核对地址与文件名。下载得到原始文件后，仍需确认它符合规则。';
    document.getElementById('download-start').disabled = false;
    document.getElementById('download-dialog').showModal();
    return true;
  }
  document.getElementById('download-close').onclick = () => document.getElementById('download-dialog').close();
  document.getElementById('download-start').onclick = async () => {
    if (!downloadModuleId || !downloadBasis) return;
    const id = downloadModuleId, basis = downloadBasis, t = task(id);
    if (t.busy) return;
    const status = document.getElementById('download-status');
    const lines = document.getElementById('download-sources').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 5) { status.textContent = '请填写 1 到 5 个文件地址。'; return; }
    const sources = lines.map(line => { const parts = line.split('|'); return { url: parts[0].trim(), name: parts.slice(1).join('|').trim() }; });
    t.busy = true; t.error = ''; t.job = null; document.getElementById('download-start').disabled = true; render();
    const run = { ...basis, sources, files: [], failures: [], confirmed: false };
    try {
      const sid = await session(id);
      Store.rejectRun(id, 'data', '开始重新下载；本次结果须重新检查并确认。');
      Store.setModuleStatus(id, 'doing');
      saved[id].download = run; persist();
      for (let i = 0; i < sources.length; i++) {
        status.textContent = '正在下载 ' + (i + 1) + ' / ' + sources.length + '：' + (sources[i].name || sources[i].url);
        try {
          const result = await request('/api/codex/fetch-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, rules: basis.text, source: sources[i], confirm: true }) });
          run.files.push(result.download); t.files = result.files;
        } catch (error) { run.failures.push({ source: sources[i], error: error.message }); }
        persist(); render();
      }
      t.files = (await request('/api/codex/files?session=' + sid)).files;
      const count = run.files.length;
      status.textContent = '完成：成功 ' + count + ' 个，失败 ' + run.failures.length + ' 个。' + (count ? '请查看文件，再确认交给清洗。' : '请检查下载地址或网络后重试。');
      Store.appendMessage(id, basis.label + '：下载成功 ' + count + ' 个，失败 ' + run.failures.length + ' 个。原始文件和下载记录在“文件与结果”中；年份、范围和版本仍待核查。' + run.failures.map(item => '\n失败：' + item.source.url + '；' + item.error).join(''), 'system');
      if (count) Store.markRun(id, { dir: '.workbench/' + sid + '/input', artifacts: run.files.map(file => ({ name: file.storedName, size: file.size })) });
      t.filesOpen = true;
    } catch (error) { status.textContent = error.message; t.error = error.message; }
    finally { t.busy = false; document.getElementById('download-start').disabled = false; render(); ModuleSpace.render(); }
  };
  async function handoffDownload(mod) {
    const t = task(mod.id), run = saved[mod.id]?.download;
    if (t.busy || !run?.files.length) return;
    if (run.failures.length) { t.error = '仍有下载失败，请补齐清单后再交给清洗。成功文件已保留。'; render(); return; }
    const basis = basisForDownload(mod, run.sourceType);
    if (!basis || basis.text !== run.text) { t.error = '下载规则已变化，请先按当前规则重新核查或下载文件。'; render(); return; }
    if (run.confirmed) {
      const clean = Store.getState().modules.find(item => item.type === 'clean-data');
      if (clean) { Store.selectModule(clean.id); return; }
    }
    t.busy = true; t.error = ''; render();
    try {
      let clean = Store.getState().modules.find(item => item.type === 'clean-data');
      if (!clean) { Store.addModule('数据清洗'); clean = Store.getState().modules.find(item => item.type === 'clean-data'); }
      if (!clean) throw new Error('无法建立清洗模块');
      const target = await session(clean.id);
      const result = await request('/api/codex/import-input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: target, sourceSessionId: saved[mod.id].sessionId, names: run.files.map(file => file.storedName), confirm: true }) });
      task(clean.id).files = result.files; task(clean.id).filesOpen = true;
      saved[clean.id].inputBatch = { names: result.names, label: run.label, text: run.text };
      run.confirmed = true; persist(); Store.confirmRun(mod.id);
      Store.appendMessage(mod.id, '已人工确认 ' + run.files.length + ' 个下载文件并交给数据清洗。' + (run.failures.length ? '本次仍有 ' + run.failures.length + ' 个下载失败，须另行补充。' : ''), 'system');
      Store.appendMessage(clean.id, '已接收下载模块确认的 ' + run.files.length + ' 个原始文件，依据“' + run.label + '”。\n来源与获取要求（用于交接，清洗规则另行确认）：\n' + run.text + '\n交接文件：\n' + run.files.map(file => file.name + '；来源：' + file.finalUrl + '；SHA-256：' + file.sha256).join('\n') + '\n请先查看输入并讨论清洗规则，再执行清洗。', 'system');
      Store.approveModule(mod.id);
      Store.selectModule(clean.id);
    } catch (error) { t.error = error.message; }
    finally { t.busy = false; render(); ModuleSpace.render(); }
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
    renderConnection();
    const state = Store.getState();
    const mod = state.modules.find(m => m.id === state.activeModuleId);
    panel.hidden = !mod || !document.getElementById('records-view').hidden;
    if (panel.hidden) return;
    const t = task(mod.id);
    panel.replaceChildren();
    const row = node('div', undefined, 'codex-toolbar');
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
    }
    panel.append(row);
    if (mod.type === 'literature-mining') {
      const discovery = node('details'); discovery.append(node('summary', '文献检索与提取（六阶段）'));
      discovery.open = t.discoveryOpen !== false;
      discovery.ontoggle = () => { if (discovery.isConnected) t.discoveryOpen = discovery.open; };
      literaturePanel(mod, t, discovery); panel.append(discovery);
      if (t.error) panel.append(node('p', t.error, 'codex-error'));
      return;
    }
    if (t.backend === 'api' && mod.type !== 'download-data') { panel.append(node('p', 'API 模式提供文字指导；数据清洗的上传与执行需切换本机 Codex。')); return; }
    if (mod.type !== 'download-data' && account?.error) panel.append(node('p', account.error + '；请打开左下角设置检查连接。', 'codex-error'));
    else if (mod.type !== 'download-data' && account && !account.loggedIn) panel.append(node('p', '请打开左下角设置，登录本机 Codex。', 'codex-error'));
    if (!['download-data', 'clean-data', 'calculation', 'result-audit'].includes(mod.type)) {
      panel.append(node('p', '本模块可用 Codex 对话梳理方案与规则；当前不执行下载、计算或文件处理。'));
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
    files.ontoggle = () => { if (!files.isConnected) return; t.filesOpen = files.open; toggle.setAttribute('aria-expanded', String(files.open)); };
    const fileRow = node('div', undefined, 'codex-toolbar');
    if (mod.type !== 'result-audit' && mod.type !== 'download-data') {
      const input = node('input'); input.type = 'file'; input.multiple = true;
      input.accept = mod.type === 'calculation' ? '.py,.r,.R,.jl,.m,.ipynb,.csv,.tsv,.xlsx,.xls,.json,.txt' : '.csv,.tsv,.xlsx,.xls,.json,.txt';
      input.disabled = t.busy;
      input.setAttribute('aria-label', mod.type === 'calculation' ? '上传计算代码和输入数据' : '上传清洗原始文件');
      input.onchange = () => upload(mod.id, Array.from(input.files)); fileRow.append(input);
    }
    const refreshButton = node('button', '刷新文件', 'quiet-button'); refreshButton.type = 'button'; refreshButton.disabled = t.busy; refreshButton.onclick = () => refresh(mod.id); fileRow.append(refreshButton);
    if (mod.type === 'download-data') {
      const start = node('button', '已有文件链接：直接下载', 'quiet-button'); start.type = 'button'; start.disabled = t.busy || !!root.LiteratureUI?.isBusy(); start.onclick = () => openDownload(mod); fileRow.append(start);
      const handoff = node('button', saved[mod.id]?.download?.confirmed ? '查看已交接的清洗模块' : '确认文件并进入清洗', 'quiet-button'); handoff.type = 'button'; handoff.disabled = t.busy || !saved[mod.id]?.download?.files.length || !!saved[mod.id]?.download?.failures.length; handoff.onclick = () => handoffDownload(mod); fileRow.append(handoff);
      const run = saved[mod.id]?.download;
      fileRow.append(node('span', run ? '下载成功 ' + run.files.length + ' 个，失败 ' + run.failures.length + ' 个；' + (run.confirmed ? '已确认交给清洗' : '待人工核查') : '先确认规则，下载后检查文件，再交给清洗。', 'codex-status'));
    }
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
    if (mod.type === 'download-data' && root.LiteratureUI) {
      const auxiliary = node('details'); auxiliary.append(node('summary', '已有文件链接或查看旧下载')); auxiliary.append(fileRow); panel.append(auxiliary);
    } else panel.append(fileRow);
    if (mod.type === 'result-audit') panel.append(node('p', '先讨论并在上方确认核查原则，或直接上传已有标准；再核查结果、讨论定位。每个标准文件上限 20MB。', 'codex-status'));
    if (mod.type === 'clean-data' && saved[mod.id]?.inputBatch) panel.append(node('p', '当前交接输入 ' + saved[mod.id].inputBatch.names.length + ' 个；历史原始文件保留，不自动合并到本次清洗。', 'codex-status'));
    const list = node('div', undefined, 'codex-files');
    list.id = 'codex-file-list';
    list.append(node('p', mod.type === 'result-audit' ? '与计算模块共享输入及各次输出；点击文件名下载。' : mod.type === 'download-data' ? '下载的原始文件与下载记录；点击文件名保存到本机。' : '上传文件与本次结果；点击文件名下载。每个上传文件上限 20MB。'));
    if (!t.files.length) list.append(node('p', mod.type === 'result-audit' ? '还没有计算文件，请先在计算模块运行。' : mod.type === 'download-data' ? '尚未下载文件，请确认规则后开始下载。' : '还没有文件，请先选择原始数据。'));
    t.files.forEach(file => {
      const displayName = file.name.split('/').pop().replace(/^[0-9a-f]{8}-/, '');
      const batch = mod.type === 'clean-data' && saved[mod.id]?.inputBatch;
      const link = node('a', (file.group === 'input' ? batch ? batch.names.includes(file.name) ? '当前原始 · ' : '历史原始 · ' : '原始 · ' : file.group === 'reference' ? '核查标准 · ' : '结果 · ') + displayName + ' · ' + Math.ceil(file.size / 1024) + 'KB');
      link.title = file.name;
      link.href = '/api/codex/download?session=' + saved[mod.id]?.sessionId + '&group=' + file.group + '&name=' + encodeURIComponent(file.name); list.append(link);
    });
    files.append(list); fileRow.append(files);
    if (t.busy) panel.append(node('p', t.job ? 'Codex 正在处理…' : '上传或启动中…', 'codex-status'));
    if (t.job?.events.length) { const log = node('details'); log.open = t.logOpen; log.ontoggle = () => { t.logOpen = log.open; }; log.append(node('summary', '执行进度')); log.append(node('pre', t.job.events.join('\n'))); panel.append(log); }
    if (t.error) panel.append(node('p', t.error, 'codex-error'));
  }
  root.CodexUI = { render, reply, openDownload, prepareConfirmedExecution, cancelPreparedExecution, session, refresh,
    getConnection: mod => ({ backend: task(mod.id).backend, model: task(mod.id).model || (task(mod.id).backend === 'codex' ? account?.model : null) || null }),
    setInputBatch: (id, batch) => { saved[id] = { ...saved[id], inputBatch: batch }; persist(); },
    useCodex: mod => !!mod && task(mod.id).backend === 'codex', getModel: mod => mod ? task(mod.id).model || null : null, busy: id => task(id).busy || task(id).literatureBusy };
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
