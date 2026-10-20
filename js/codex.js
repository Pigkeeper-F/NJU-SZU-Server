/* Local Codex connection and task files for the cleaning module. */
(function (root) {
  'use strict';
  const tasks = {};
  const key = 'research_codex_tasks_v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_) {}
  const literatureFieldDraftKey = 'research_literature_field_drafts_v1';
  let literatureFieldDrafts = {};
  try {
    const value = JSON.parse(localStorage.getItem(literatureFieldDraftKey));
    if (value && typeof value === 'object' && !Array.isArray(value)) literatureFieldDrafts = value;
  } catch (_) {}
  let literatureFieldsDialog = null;
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
      literatureUntil: saved[id]?.literatureUntil || 'discover', literatureJobs: null, literatureJobsTried: false, literatureJobsLoading: false, literatureJobsError: '', literatureIncludeDeleted: false, literatureHistoryBusy: null,
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
      if (Store.getState().modules.find(mod => mod.id === id)?.type === 'plotting') await loadPlotRuns(id);
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
          if (Store.getState().modules.find(mod => mod.id === id)?.type === 'plotting') await loadPlotRuns(id);
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
    const base = '候选检索已保存 ' + job.count + ' 条待复核记录；这不是已纳入文献，也未提取全文。可在文献检索区下载清单。';
    const extra = literatureDeliverableSummary(job);
    return (extra ? base + extra : base) + literatureProcessingBasisMessage(job);
  }
  function literatureProcessingBasisMessage(job) {
    const basis = job?.processingBasis;
    if (!basis) return '';
    const count = Number.isSafeInteger(basis.candidateCount) && basis.candidateCount >= 0 ? basis.candidateCount : '待核对';
    const omitted = Array.isArray(basis.deferredSources) ? basis.deferredSources.map(source => LITERATURE_SOURCE_LABELS[source] || source).join('、') : '待核对';
    return '本次后续处理基于现有' + count + '条候选；待补检来源：' + (omitted || '待核对')
      + '，当前快照不代表全部来源已检索完成。原检索任务仍可在历史中补检，补检结果不会自动混入此快照。';
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
  async function checkLiteratureRuntime(sources = []) {
    const restart = '当前端口后台需要更新。请关闭对应的旧启动窗口，重新打开本项目启动器，再刷新页面；已有任务和文件保留。';
    let runtime;
    try { runtime = await request('/api/literature/runtime'); }
    catch (_) { throw new Error(restart + ' 当前后台未能提供版本核对接口。'); }
    if (!runtime || runtime.protocolVersion !== 1 || runtime.restartRequired !== false
      || runtime.browserSession !== 'persistent-research-browser' || !Array.isArray(runtime.supportedSources)) {
      throw new Error(restart);
    }
    const missing = sources.filter(source => !runtime.supportedSources.includes(source));
    if (missing.length) throw new Error(restart + ' 当前后台尚未加载来源：' + missing.map(source => LITERATURE_SOURCE_LABELS[source] || source).join('、') + '。');
    return runtime;
  }
  async function autoOpenLiteratureBrowser(id, job) {
    const source = job.attention?.source, reason = job.attention?.reason;
    const t = task(id);
    if (job.status !== 'needs_attention' || job.stage === 'awaiting_confirmation' || job.deferredOnly === true
      || !LITERATURE_EXECUTABLE_SOURCES.includes(source) || !['login', 'verification', 'access_required'].includes(reason)) {
      t.literatureAutoOpenNotice = ''; return false;
    }
    const event = Array.isArray(job.events) ? job.events[job.events.length - 1] : null;
    const stamp = JSON.stringify([job.id, source, reason, event?.at || '', event?.stage || '', event?.message || job.message || '', job.events?.length || 0]);
    if (saved[id]?.literatureAutoOpenStamp === stamp || t.literatureAutoOpening) return false;
    saved[id] = { ...saved[id], literatureAutoOpenStamp: stamp }; persist();
    t.literatureAutoOpening = true;
    try {
      await checkLiteratureRuntime(job.config?.sources || [source]);
      await request('/api/literature/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) });
      t.literatureAutoOpenNotice = '已请求打开本任务的官方页面。请在平台专用检索浏览器完成登录或验证，再回到这里点击“检查并继续”。';
      return true;
    } catch (error) {
      t.literatureAutoOpenNotice = '未能自动打开检索页面：' + error.message + ' 可处理问题后点击“打开登录/检索页面”重试。';
      return false;
    } finally { t.literatureAutoOpening = false; }
  }
  async function watchLiterature(id, jobId) {
    const t = task(id);
    const generation = (t.literatureWatchGeneration || 0) + 1; t.literatureWatchGeneration = generation;
    t.literatureBusy = true;
    try {
      while (true) {
        const job = await request('/api/literature/job?id=' + encodeURIComponent(jobId));
        if (t.literatureWatchGeneration !== generation) return;
        if (job.deletedAt) { detachLiteratureJob(id, jobId); render(); return; }
        t.literatureJob = job;
        if (job.status !== 'needs_attention') t.literatureAutoOpenNotice = '';
        render();
        if (job.status !== 'running') {
          await autoOpenLiteratureBrowser(id, job);
          if (t.literatureWatchGeneration !== generation) return;
          const stamp = job.id + ':' + job.status + ':' + (job.stage || '') + ':' + (Array.isArray(job.events) ? job.events.length : 0);
          if (saved[id]?.literatureDelivered !== stamp) {
            const text = job.status === 'completed' ? literatureCompletedMessage(job)
              : job.status === 'needs_attention' && job.stage === 'awaiting_confirmation'
                ? '提取前需由研究者确认参数字段含义与单位：请在文献检索区核对字段并点击“确认并继续提取”。'
              : job.status === 'needs_attention' ? literatureAttentionMessage(job)
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
    } catch (error) { if (t.literatureWatchGeneration === generation) t.literatureError = error.message; }
    finally { if (t.literatureWatchGeneration === generation) { t.literatureBusy = false; render(); } }
  }
  function detachLiteratureJob(id, jobId) {
    const t = task(id);
    if (t.literatureJob?.id !== jobId && saved[id]?.literatureJobId !== jobId) return;
    t.literatureWatchGeneration = (t.literatureWatchGeneration || 0) + 1;
    t.literatureJob = null; t.literatureBusy = false; t.literatureError = ''; t.literatureAutoOpenNotice = '';
    if (saved[id]) {
      delete saved[id].literatureJobId; delete saved[id].literatureDelivered; delete saved[id].literatureAutoOpenStamp;
    }
    closeLiteratureFields(); persist();
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
    let config;
    try {
      config = newLiteratureSearchConfig(t.literatureConfig);
      config.extraction = { ...config.extraction, model: t.model || account?.model || config.extraction?.model || null };
    } catch (error) { t.literatureError = error.message; render(); return; }
    if (saved[mod.id]?.literatureSource !== literatureSource(mod)) { t.literatureError = '对话或已批准文档有更新，请重新整理规则后再检索'; render(); return; }
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(config.sources || []);
      const body = { config, until: t.literatureUntil || 'discover' };
      const job = await request('/api/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      t.literatureJob = job;
      t.literatureConfig = JSON.parse(JSON.stringify(job.config || config));
      saved[mod.id] = { ...saved[mod.id], literatureJobId: job.id, literatureConfig: t.literatureConfig };
      persist();
      await watchLiterature(mod.id, job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function continueLiterature(mod, options = {}) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可继续的检索任务'; render(); return; }
    const deferSource = options.deferSource;
    const restoreFrozenOrder = deferSource !== undefined && t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig)
      && sameLiteratureDeferralConfig(job.config, t.literatureConfig);
    if (t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig) && !restoreFrozenOrder) {
      t.literatureError = '本次设置已改变，不能混入旧任务结果；请确认新配置并发起新检索，或从历史任务重新载入原配置'; render(); return;
    }
    if (deferSource !== undefined && (job.status !== 'needs_attention' || job.resumeStage !== 'discover'
      || deferSource !== job.attention?.source || !LITERATURE_EXECUTABLE_SOURCES.includes(deferSource) || !job.config?.sources?.includes(deferSource))) {
      t.literatureError = '只能暂缓当前等待人工处理的检索来源；请刷新任务状态后重试。'; render(); return;
    }
    const until = options.until || (deferSource !== undefined ? job.until || t.literatureUntil || 'discover' : t.literatureUntil || job.until || 'discover');
    if (job.resumeStage && LITERATURE_STAGE_ORDER.indexOf(until) < LITERATURE_STAGE_ORDER.indexOf(job.resumeStage)) {
      t.literatureError = '请先在“本次做到哪一步”选择“' + literatureStageLabel(job.resumeStage) + '”或更后的阶段，再继续原任务'; render(); return;
    }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const body = { id: job.id, until, ...(deferSource !== undefined ? { deferSource } : {}) };
      const next = await request('/api/literature/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (restoreFrozenOrder) {
        t.literatureConfig = JSON.parse(JSON.stringify(job.config));
        saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig }; persist();
      }
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, next.id || job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function continueAvailableLiterature(mod) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id || job.deletedAt || job.status === 'running' || job.deferredOnly !== true || !Number.isSafeInteger(job.count) || job.count <= 0) {
      t.literatureError = '当前任务仍需检索或没有可用候选，不能按已有结果建立后续运行。'; render(); return;
    }
    if (t.literatureConfig && !sameLiteratureDeferralConfig(job.config, t.literatureConfig)) {
      t.literatureError = '检索设置已改变，请先从历史载入原任务；后续处理使用原任务的候选与冻结规则快照。'; render(); return;
    }
    const until = LITERATURE_STAGE_ORDER.indexOf(t.literatureUntil) >= LITERATURE_STAGE_ORDER.indexOf('dedupe') ? t.literatureUntil : 'dedupe';
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const next = await request('/api/literature/continue-available', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, until }) });
      if (!next?.id || next.id === job.id || !next.processingBasis) throw new Error('未收到可核对的独立后续运行，请刷新历史任务查看；原任务保留。');
      t.literatureConfig = JSON.parse(JSON.stringify(next.config || job.config)); t.literatureUntil = next.until || until;
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureUntil: t.literatureUntil,
        literatureSource: literatureSource(mod) };
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, next.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function reviewLiteratureFulltext(mod) {
    const t = task(mod.id), job = t.literatureJob;
    if (t.busy || t.literatureBusy || root.LiteratureUI?.isBusy() || !job?.id || job.canReviewFulltext !== true) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const next = await request('/api/literature/review-fulltext', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id }) });
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function retryLiteratureCnki(mod, paperId, restart = false) {
    const t = task(mod.id), job = t.literatureJob;
    if (t.busy || t.literatureBusy || root.LiteratureUI?.isBusy() || !job?.id || job.deletedAt || job.status === 'running') return;
    if (!Array.isArray(job.cnkiRetryItems) || !job.cnkiRetryItems.some(item => item.id === paperId)) {
      t.literatureError = '这篇文献不在当前可重试的知网清单中，请刷新任务状态后再操作。'; render(); return;
    }
    if (restart === true && (job.cnkiRetryPaperId !== paperId || !['needs_attention', 'failed'].includes(job.status))) {
      t.literatureError = '只能重新定位当前已暂停的这篇知网文献，请刷新任务状态后再操作。'; render(); return;
    }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const next = await request(restart === true ? '/api/literature/restart-cnki' : '/api/literature/retry-cnki', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, paperId }) });
      if (next?.id !== job.id) throw new Error('单篇全文任务标识不符，请刷新原任务核对。');
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  function literatureAttentionMessage(job) {
    const source = job.attention?.source;
    if (job.resumeStage === 'fulltext') return String(job.message || job.error || '全文获取已暂停，已有材料保留。');
    if (job.deferredOnly === true) return '已暂缓，当前没有其他待检索来源。原来源仍待补检，已有候选保留；可用已有候选建立后续处理运行，或在原页面核对后点击“补检该来源”。';
    if (job.attention?.reason === 'results_unrecognized') {
      const prefix = LITERATURE_EXECUTABLE_SOURCES.includes(source) ? (LITERATURE_SOURCE_LABELS[source] || source) + '：' : '';
      return prefix + String(job.message || job.error || '尚不能确认当前检索页面，已有结果保留。');
    }
    const message = String(job.message || job.error || (LITERATURE_EXECUTABLE_SOURCES.includes(source) ? '需要人工处理' : '检索已暂停，已有结果保留')).trim().replace(/[。.]+$/, '');
    if (!LITERATURE_EXECUTABLE_SOURCES.includes(source)) {
      return message + '。处理问题后点击“检查并继续”，从原任务保存的位置恢复。';
    }
    const label = LITERATURE_SOURCE_LABELS[source] || source || '当前来源';
    return label + '：' + message + '。请在平台专用检索浏览器的官方页面处理后，点击“检查并继续”；普通 Edge/Chrome 的登录不会自动共享。';
  }
  async function openLiteratureBrowser(mod) {
    const t = task(mod.id);
    if (t.busy || t.literatureBusy || root.LiteratureUI?.isBusy() || !t.literatureJob?.id) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(t.literatureJob.config?.sources || []);
      await request('/api/literature/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.literatureJob.id }) });
      t.literatureAutoOpenNotice = t.literatureJob.resumeStage === 'fulltext' ? '已请求显示原全文任务页；处理页面问题后，点击“继续获取全文”。'
        : t.literatureJob.deferredOnly === true ? '已请求打开原任务页面，确认可用后回到这里点击“补检该来源”。'
        : '已请求打开本任务的官方页面，请在平台专用检索浏览器处理后回到这里点击“检查并继续”。';
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function confirmLiteratureFields(mod) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可确认的检索任务'; render(); return; }
    if (job.status !== 'needs_attention' || job.stage !== 'awaiting_confirmation') {
      t.literatureFieldsError = '当前可先保存字段草稿；运行到提取阶段后再确认。'; renderLiteratureFieldsDialog(); return;
    }
    if (t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig)) {
      t.literatureFieldsError = '检索设置已改变，请从历史任务重新载入原配置后再确认提取字段；字段草稿会保留。'; renderLiteratureFieldsDialog(); return;
    }
    const until = t.literatureUntil || job.until || 'discover';
    if (LITERATURE_STAGE_ORDER.indexOf(until) < LITERATURE_STAGE_ORDER.indexOf('extract')) {
      t.literatureFieldsError = '请先将“本次做到哪一步”改为参数提取或更后的阶段，再确认字段'; renderLiteratureFieldsDialog(); return;
    }
    ensureLiteratureFieldDrafts(t, job);
    let fields;
    try { fields = validatedLiteratureFields(t); }
    catch (error) { t.literatureFieldsError = error.message; renderLiteratureFieldsDialog(); return; }
    if (!saveLiteratureFieldDrafts(t, job)) { renderLiteratureFieldsDialog(); return; }
    t.literatureBusy = true; t.literatureError = ''; t.literatureFieldsError = ''; render(); renderLiteratureFieldsDialog();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const next = await request('/api/literature/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, until, confirmations: { fields } }) });
      t.literatureConfirmJob = null; t.literatureConfirmDrafts = null;
      closeLiteratureFields();
      applyLiteratureJob(mod, next);
      Store.appendMessage(mod.id, '已记录研究者确认的参数字段（' + fields.length + ' 项），继续执行提取。', 'system');
      await watchLiterature(mod.id, next.id || job.id);
    } catch (error) { t.literatureError = error.message; t.literatureFieldsError = error.message; }
    finally { t.literatureBusy = false; render(); renderLiteratureFieldsDialog(); }
  }
  async function loadLiteratureJobs(mod, options = {}) {
    const t = task(mod.id);
    if (t.literatureJobsLoading) return;
    t.literatureJobsLoading = true; t.literatureJobsTried = true;
    try {
      const data = await request('/api/literature/jobs?limit=20' + (t.literatureIncludeDeleted ? '&includeDeleted=1' : ''));
      t.literatureJobs = Array.isArray(data.jobs) ? data.jobs : [];
      t.literatureJobsError = '';
    } catch (error) {
      t.literatureJobs = t.literatureJobs || [];
      t.literatureJobsError = options.silent ? '' : error.message;
    }
    finally { t.literatureJobsLoading = false; render(); }
  }
  async function changeLiteratureHistory(mod, job, restore = false) {
    const t = task(mod.id);
    if (!job?.id || t.literatureHistoryBusy || t.literatureJobsLoading) return;
    if (job.status === 'running') { t.literatureJobsError = '任务正在运行，请先停止后再删除。'; render(); return; }
    t.literatureHistoryBusy = job.id; t.literatureJobsError = ''; render();
    try {
      const next = await request(restore ? '/api/literature/restore' : '/api/literature/delete', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) });
      if (!restore) detachLiteratureJob(mod.id, job.id);
      t.literatureJobs = (t.literatureJobs || []).map(item => item.id === job.id ? next : item)
        .filter(item => t.literatureIncludeDeleted || !item.deletedAt);
      await loadLiteratureJobs(mod);
    } catch (error) { t.literatureJobsError = (restore ? '恢复失败：' : '删除失败：') + error.message; }
    finally { t.literatureHistoryBusy = null; render(); }
  }
  function attachLiteratureJob(mod, job) {
    const t = task(mod.id);
    if (!job?.id) return;
    if (job.deletedAt) { t.literatureJobsError = '该任务已删除，请先点击“恢复”。'; render(); return; }
    t.literatureError = '';
    if (job.config) {
      t.literatureConfig = JSON.parse(JSON.stringify(job.config));
      t.literatureUntil = job.until || 'discover';
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureUntil: t.literatureUntil,
        literatureSource: literatureSource(mod) };
    }
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
    'studyTypes', 'inclusion', 'exclusion', 'targetFields', 'limit', 'sourceQueries', 'searchMode', 'perSourceLimit', 'stopMode'];
  const LITERATURE_CONFIG_EXTRA_KEYS = ['batch', 'fieldDefinitions', 'templates', 'fulltext', 'extraction', 'limits'];
  function literatureConfigKey(config, keys = LITERATURE_CONFIG_KEYS) {
    if (!config) return '';
    return JSON.stringify(keys.map(key => key === 'sourceQueries'
      ? Object.entries(config.sourceQueries || {}).filter(([, value]) => String(value).trim()).sort(([a], [b]) => a.localeCompare(b))
      : key === 'stopMode' ? config.stopMode ?? 'count'
      : key === 'perSourceLimit' && config.searchMode === 'test' ? 10
      : key === 'perSourceLimit' && config.searchMode === 'formal' && config.stopMode === 'end' ? null
      : key === 'perSourceLimit' && config.searchMode === 'formal' ? config.perSourceLimit === undefined ? 100 : config.perSourceLimit
      : config[key] ?? null));
  }
  function newLiteratureSourceOrder(sources) {
    if (!Array.isArray(sources)) return sources;
    return [...sources.filter(source => source !== 'web-of-science'), ...sources.filter(source => source === 'web-of-science')];
  }
  function newLiteratureSearchConfig(config) {
    const mode = config.searchMode ?? 'test';
    if (!['test', 'formal'].includes(mode)) throw new Error('请选择测试运行或正式检索');
    const next = { ...config, sources: newLiteratureSourceOrder(config.sources), searchMode: mode, stopMode: mode === 'formal' ? 'end' : 'count', perSourceLimit: mode === 'formal' ? null : 10, limit: 10,
      ...(config.batch ? { batch: { ...config.batch, size: 10 } } : {}) };
    if (mode === 'formal' && config.stopMode !== 'end' && config.limits) {
      next.limits = { ...config.limits }; delete next.limits.discover;
    }
    return next;
  }
  function sameLiteratureConfig(one, other) {
    if (!one || !other) return false;
    const keys = [...LITERATURE_CONFIG_KEYS, ...LITERATURE_CONFIG_EXTRA_KEYS.filter(key => one[key] !== undefined && other[key] !== undefined)];
    return literatureConfigKey(one, keys) === literatureConfigKey(other, keys);
  }
  function sameLiteratureDeferralConfig(one, other) {
    if (sameLiteratureConfig(one, other)) return true;
    if (!Array.isArray(one?.sources) || !Array.isArray(other?.sources)
      || JSON.stringify([...one.sources].sort()) !== JSON.stringify([...other.sources].sort())) return false;
    return sameLiteratureConfig(one, { ...other, sources: [...one.sources] });
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
    if (config.sourceQueries !== undefined) {
      if (!config.sourceQueries || typeof config.sourceQueries !== 'object' || Array.isArray(config.sourceQueries)
        || Object.values(config.sourceQueries).some(value => typeof value !== 'string' || value.length > 2000)) {
        throw new Error('各来源检索式格式无效；请重新整理或手动填写');
      }
      parsed.sourceQueries = Object.fromEntries(Object.entries(config.sourceQueries).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    }
    ['batch', 'templates', 'fulltext', 'extraction', 'limits'].forEach(key => {
      if (config[key] && typeof config[key] === 'object' && !Array.isArray(config[key])) parsed[key] = config[key];
    });
    if (Array.isArray(config.fieldDefinitions) && config.fieldDefinitions.every(field => field && typeof field === 'object' && !Array.isArray(field))) {
      parsed.fieldDefinitions = config.fieldDefinitions;
    }
    return newLiteratureSearchConfig({ ...parsed, searchMode: config.searchMode ?? 'test', stopMode: config.stopMode });
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
    t.literatureConfig = { topic: '', query: '', sources: ['google-scholar'], sourceQueries: {}, publicationYearFrom: null, publicationYearTo: null,
      geography: '', language: '', studyTypes: [], inclusion: [], exclusion: [], targetFields: [], limit: 10, searchMode: 'test', stopMode: 'count', perSourceLimit: 10 };
    saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureSource: literatureSource(mod) };
    persist(); render();
  }
  const LITERATURE_STAGE_ORDER = ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'];
  const LITERATURE_STAGE_LABELS = { 'queued': '排队中', 'environment': '准备环境', 'browser': '启动浏览器', 'discover': '检索候选', 'search': '检索候选', 'save': '保存候选',
    'dedupe': '跨来源去重', 'fulltext': '获取全文', 'fulltext_review': '复核全文缓存', 'fulltext_ready': '待核查全文', 'extraction': '提取参数', 'extract': '提取参数', 'validation': '校验参数', 'validate': '校验参数',
    'export': '导出两表', 'verification': '等待人工验证', 'login': '等待登录', 'access_required': '等待访问权限',
    'results_unrecognized': '待核对检索页面', 'awaiting_confirmation': '等待确认字段',
    'completed': '已完成', 'failed': '失败', 'cancelled': '已停止', 'interrupted': '已中断', 'running': '进行中' };
  const LITERATURE_STAGE_STATES = { 'pending': '待运行', 'running': '进行中', 'done': '已完成', 'failed': '失败', 'skipped': '已跳过' };
  const LITERATURE_COUNTER_LABELS = { 'candidates': '候选', 'uniqueGroups': '去重组', 'fulltextFetched': '已获取全文',
    'fulltextPdf': 'PDF正文', 'fulltextHtml': 'HTML正文', 'fulltextAbstract': '仅摘要', 'fulltextUnavailable': '待补充',
    'fulltextAttention': '待人工处理', 'fulltextPending': '尚未处理', 'extractedPapers': '已提取论文', 'parameterRows': '参数行' };
  const LITERATURE_UNTIL_OPTIONS = [['discover', '仅检索候选'], ['dedupe', '续跑到去重'], ['fulltext', '续跑到全文获取'],
    ['extract', '续跑到参数提取'], ['validate', '续跑到校验'], ['export', '完整流水线']];
  const LITERATURE_STATUS_LABELS = { 'running': '进行中', 'completed': '已完成', 'needs_attention': '需要人工', 'failed': '失败', 'cancelled': '已停止' };
  const LITERATURE_SOURCE_LABELS = { 'google-scholar': 'Google Scholar', 'cnki': '中国知网', 'web-of-science': 'Web of Science 核心合集',
    'wanfang': '万方', 'scopus': 'Scopus', 'pubmed': 'PubMed' };
  const LITERATURE_EXECUTABLE_SOURCES = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'];
  const LITERATURE_FILE_LABELS = { 'run_config.json': '运行配置（冻结）', 'processing-basis.json': '本次处理依据', 'candidates.json': '候选清单 JSON（累计）', 'candidates.csv': '候选清单 CSV（累计）',
    'dedupe/dedupe.json': '去重结果 JSON', 'dedupe/dedupe.csv': '去重结果 CSV', 'fulltext/status.json': '全文获取状态',
    'fulltext/review.json': '全文缓存复核报告',
    'extraction/check_report.json': '提取校验报告', 'validation/validation.json': '校验结果 JSON', 'validation/validation.md': '待审核清单',
    'export/literature.csv': '文献表 CSV', 'export/literature.xlsx': '文献表 Excel', 'export/parameters.csv': '参数明细表 CSV',
    'export/parameters.xlsx': '参数明细表 Excel', 'export/export_report.md': '导出报告' };
  const LITERATURE_FILE_GROUPS = [['dedupe', '去重产物'], ['fulltext', '已保存材料与全文记录'], ['extraction', '提取产物'], ['validation', '校验产物'], ['export', '导出产物']];
  function literatureStageLabel(stage) { return LITERATURE_STAGE_LABELS[stage] || String(stage || ''); }
  function literatureFileLabel(name) {
    if (LITERATURE_FILE_LABELS[name]) return LITERATURE_FILE_LABELS[name];
    let match = name.match(/^fulltext\/files\/(.+)\.(pdf|txt)$/);
    if (match) return '材料 · ' + match[1] + (match[2] === 'pdf' ? '（PDF）' : '（文本）');
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
      if (group.key === 'fulltext') section.append(node('p', '保存了文件不代表已确认全文，请以全文状态和复核报告中的分类为准。', 'codex-status'));
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
      const paused = job.status === 'needs_attention' && job.resumeStage === stage;
      const state = paused ? 'pending' : LITERATURE_STAGE_STATES[job.stages[stage]] ? job.stages[stage] : 'pending';
      const item = node('span', undefined, 'literature-stage is-' + state);
      item.append(node('span', stage === 'discover' && job.processingBasis ? '候选快照就绪' : LITERATURE_STAGE_LABELS[stage] || stage));
      item.append(node('span', paused ? job.deferredOnly === true ? '已暂缓，待补检' : '待人工处理' : LITERATURE_STAGE_STATES[state], 'literature-stage-state'));
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
    const sources = [job?.config || {}];
    for (const source of sources) {
      if (Array.isArray(source.fieldDefinitions) && source.fieldDefinitions.length) {
        return source.fieldDefinitions.map(field => ({ ...JSON.parse(JSON.stringify(field)), key: String(field?.key ?? ''), label: String(field?.label ?? field?.key ?? ''),
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
  function ensureLiteratureFieldDrafts(t, job) {
    if (t.literatureConfirmJob !== job.id || !Array.isArray(t.literatureConfirmDrafts)) {
      const stored = Object.prototype.hasOwnProperty.call(literatureFieldDrafts, job.id) ? literatureFieldDrafts[job.id] : null;
      const fields = Array.isArray(stored?.fields) ? stored.fields : literatureConfirmFields(t, job);
      t.literatureConfirmDrafts = JSON.parse(JSON.stringify(fields.filter(field => field && typeof field === 'object' && !Array.isArray(field))));
      t.literatureConfirmJob = job.id;
      t.literatureFieldsError = '';
    }
    return t.literatureConfirmDrafts;
  }
  function saveLiteratureFieldDrafts(t, job) {
    if (!job?.id || t.literatureConfirmJob !== job.id || !Array.isArray(t.literatureConfirmDrafts)) return false;
    literatureFieldDrafts[job.id] = { fields: JSON.parse(JSON.stringify(t.literatureConfirmDrafts)) };
    try {
      localStorage.setItem(literatureFieldDraftKey, JSON.stringify(literatureFieldDrafts));
      t.literatureFieldsError = ''; return true;
    } catch (_) {
      t.literatureFieldsError = '字段草稿暂时无法保存到浏览器，请保留当前页面并检查浏览器存储空间。'; return false;
    }
  }
  function addLiteratureField(mod, t, job) {
    if (t.literatureBusy || t.busy || job.status === 'running') return;
    const drafts = ensureLiteratureFieldDrafts(t, job);
    if (drafts.length >= 50) { t.literatureFieldsError = '每个任务最多设置50个提取字段。'; renderLiteratureFieldsDialog(); return; }
    const keys = new Set(drafts.map(field => String(field.key || '').trim()));
    let index = 1; while (keys.has('field_' + index)) index++;
    drafts.push({ key: 'field_' + index, label: '', meaning: '', unit: '', valueType: 'text', required: false });
    saveLiteratureFieldDrafts(t, job); renderLiteratureFieldsDialog();
  }
  function removeLiteratureField(mod, t, job, index) {
    if (t.literatureBusy || t.busy || job.status === 'running') return;
    const drafts = ensureLiteratureFieldDrafts(t, job);
    if (!Number.isInteger(index) || index < 0 || index >= drafts.length) return;
    drafts.splice(index, 1); saveLiteratureFieldDrafts(t, job); renderLiteratureFieldsDialog();
  }
  function validatedLiteratureFields(t) {
    const drafts = t.literatureConfirmDrafts || [];
    if (!drafts.length) throw new Error('请点击“新增提取字段”，填写本次要提取的表头。');
    if (drafts.length > 50) throw new Error('每个任务最多设置50个提取字段。');
    const fields = drafts.map(draft => ({ ...JSON.parse(JSON.stringify(draft)), key: String(draft.key || '').trim(), label: String(draft.label || '').trim(),
      meaning: String(draft.meaning || '').trim(), unit: String(draft.unit || '').trim(), valueType: draft.valueType || 'text', required: draft.required === true }));
    if (fields.some(field => !field.key || field.key.length > 100)) throw new Error('字段标识无效，请删除该行后重新新增。');
    if (new Set(fields.map(field => field.key)).size !== fields.length) throw new Error('字段标识重复，请删除重复行后重新新增。');
    if (fields.some(field => !field.label || field.label.length > 200)) throw new Error('请为每个字段填写表头名称（最多200字）。');
    if (new Set(fields.map(field => field.label)).size !== fields.length) throw new Error('表头名称不能重复，请明确区分不同字段。');
    if (fields.some(field => !field.meaning || field.meaning.length > 500)) throw new Error('请填写每个字段的含义（最多500字）。');
    if (fields.some(field => field.unit.length > 100 || (field.valueType === 'number' && !field.unit))) throw new Error('请明确数值字段的单位，可填写“无量纲”或“原文单位”（最多100字）。');
    if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > 60 * 1024) throw new Error('字段说明总量超过单次确认容量，请精简含义或其他字段规则后再确认；草稿会保留。');
    return fields;
  }
  function closeLiteratureFields() {
    if (!literatureFieldsDialog) return;
    const dialog = literatureFieldsDialog.element;
    literatureFieldsDialog = null;
    dialog.close(); dialog.remove();
  }
  function renderLiteratureFieldsDialog() {
    if (!literatureFieldsDialog) return;
    const { element: dialog, mod, jobId } = literatureFieldsDialog;
    const t = task(mod.id), job = t.literatureJob;
    if (job?.id !== jobId) { closeLiteratureFields(); return; }
    dialog.replaceChildren();
    const head = node('div', undefined, 'literature-help-head');
    head.append(node('h2', '提取字段与表头'));
    const close = node('button', '关闭', 'quiet-button'); close.type = 'button'; close.onclick = closeLiteratureFields;
    head.append(close); dialog.append(head, literatureConfirmForm(mod, t, job));
    const save = node('button', '保存草稿并关闭', 'quiet-button'); save.type = 'button'; save.disabled = t.literatureBusy || t.busy;
    save.onclick = () => { if (saveLiteratureFieldDrafts(t, job)) { closeLiteratureFields(); render(); } else renderLiteratureFieldsDialog(); };
    dialog.append(save);
  }
  function openLiteratureFields(mod) {
    const t = task(mod.id), job = t.literatureJob;
    if (!job?.id || t.literatureBusy || t.busy || job.status === 'running') return;
    ensureLiteratureFieldDrafts(t, job);
    closeLiteratureFields();
    const dialog = node('dialog', undefined, 'literature-help-dialog');
    dialog.setAttribute('aria-label', '提取字段与表头');
    dialog.onclose = () => { if (literatureFieldsDialog?.element === dialog) literatureFieldsDialog = null; dialog.remove(); };
    literatureFieldsDialog = { element: dialog, mod, jobId: job.id };
    document.body.append(dialog); renderLiteratureFieldsDialog(); dialog.showModal();
  }
  function literatureConfirmForm(mod, t, job) {
    const box = node('div', undefined, 'literature-confirm');
    const awaitingConfirm = job.status === 'needs_attention' && job.stage === 'awaiting_confirmation';
    box.append(node('p', awaitingConfirm ? '请核对表头名称、字段含义和单位；确认后继续当前任务的提取。'
      : '先讨论并填写提取字段。保存草稿后可继续获取全文，进入提取阶段时再确认。'));
    box.append(node('p', '当前任务 ' + job.id.slice(0, 8) + ' · 已有候选与全文保留；编辑字段不会重新检索。', 'codex-status'));
    const drafts = ensureLiteratureFieldDrafts(t, job);
    const disabled = t.literatureBusy || t.busy || job.status === 'running';
    if (!drafts.length) box.append(node('p', '还没有提取字段，点击“新增提取字段”开始填写。', 'codex-status'));
    const notice = node('p', t.literatureFieldsError || '草稿自动保存在本浏览器，保存草稿不会启动提取。', t.literatureFieldsError ? 'codex-error' : 'codex-status');
    notice.setAttribute('aria-live', 'polite');
    const saveDraft = () => {
      saveLiteratureFieldDrafts(t, job);
      notice.textContent = t.literatureFieldsError || '草稿已保存在本浏览器，尚未提交确认。';
      notice.className = t.literatureFieldsError ? 'codex-error' : 'codex-status';
    };
    const fields = node('div', undefined, 'literature-confirm-fields');
    drafts.forEach((draft, index) => {
      const cell = node('div', undefined, 'literature-confirm-row');
      [['label', '表头名称', 200], ['meaning', '含义', 500], ['unit', '单位', 100]].forEach(([key, title, maxLength]) => {
        const wrap = node('label', title); const field = node('input'); field.type = 'text';
        field.setAttribute('aria-label', '第' + (index + 1) + '个字段' + title); field.maxLength = maxLength;
        field.value = draft[key] ?? ''; field.disabled = disabled;
        field.oninput = () => { draft[key] = field.value; saveDraft(); };
        wrap.append(field); cell.append(wrap);
      });
      const typeWrap = node('label', '类型');
      const type = node('select');
      const types = ['text', 'number'].concat(['text', 'number'].includes(draft.valueType) ? [] : [draft.valueType]);
      types.forEach(value => { const option = node('option', value === 'number' ? '数值' : value === 'text' ? '文本' : value); option.value = value; type.append(option); });
      type.setAttribute('aria-label', '第' + (index + 1) + '个字段类型');
      type.value = draft.valueType; type.disabled = disabled;
      type.onchange = () => { draft.valueType = type.value; saveDraft(); };
      typeWrap.append(type); cell.append(typeWrap);
      const requiredWrap = node('label', '必填');
      const required = node('input'); required.type = 'checkbox'; required.checked = draft.required === true; required.disabled = disabled;
      required.setAttribute('aria-label', '第' + (index + 1) + '个字段必填');
      required.onchange = () => { draft.required = required.checked; saveDraft(); };
      requiredWrap.prepend(required); cell.append(requiredWrap);
      const remove = node('button', '删除', 'quiet-button'); remove.type = 'button'; remove.disabled = disabled;
      remove.setAttribute('aria-label', '删除第' + (index + 1) + '个提取字段');
      remove.onclick = () => removeLiteratureField(mod, t, job, index); cell.append(remove);
      fields.append(cell);
    });
    box.append(fields);
    const actions = node('div', undefined, 'literature-confirm-actions');
    const add = node('button', '新增提取字段', 'quiet-button'); add.type = 'button'; add.disabled = disabled || drafts.length >= 50;
    add.onclick = () => addLiteratureField(mod, t, job); actions.append(add);
    if (awaitingConfirm) {
      const confirm = node('button', t.literatureBusy ? '提交中…' : '确认并继续提取', 'primary-button');
      confirm.type = 'button'; confirm.disabled = disabled || !drafts.length || !!root.LiteratureUI?.isBusy();
      confirm.onclick = () => confirmLiteratureFields(mod); actions.append(confirm);
    }
    box.append(actions, notice);
    return box;
  }
  function literatureHistory(mod, t) {
    if (!t.literatureJobs && !t.literatureJobsTried && !t.literatureJobsLoading) void loadLiteratureJobs(mod, { silent: true });
    const box = node('details', undefined, 'literature-history');
    box.append(node('summary', '历史任务（刷新后仍可找回）' + (Array.isArray(t.literatureJobs) ? ' · ' + t.literatureJobs.length : '')));
    const head = node('div', undefined, 'literature-history-head');
    const refresh = node('button', t.literatureJobsLoading ? '刷新中…' : '刷新任务列表', 'quiet-button');
    refresh.type = 'button'; refresh.disabled = t.literatureJobsLoading || !!t.literatureHistoryBusy;
    refresh.onclick = () => loadLiteratureJobs(mod);
    const deleted = node('button', t.literatureIncludeDeleted ? '隐藏已删除' : '查看已删除', 'quiet-button'); deleted.type = 'button';
    deleted.disabled = t.literatureJobsLoading || !!t.literatureHistoryBusy;
    deleted.onclick = () => { t.literatureIncludeDeleted = !t.literatureIncludeDeleted; return loadLiteratureJobs(mod); };
    head.append(refresh, deleted); box.append(head);
    box.append(node('p', '删除后可在“查看已删除”中恢复，原文件和进度保留。', 'codex-status'));
    if (!Array.isArray(t.literatureJobs)) box.append(node('p', '正在读取历史任务…', 'codex-status'));
    else if (!t.literatureJobs.length) box.append(node('p', '暂无历史任务记录。', 'codex-status'));
    else {
      const list = node('div', undefined, 'literature-history-list');
      t.literatureJobs.forEach(job => {
        const row = node('div', undefined, 'literature-history-row' + (job.id === t.literatureJob?.id ? ' is-current' : ''));
        row.append(node('span', String(job.id || '').slice(0, 8), 'literature-history-id'));
        row.append(node('span', job.deletedAt ? '已删除，可恢复' : job.deferredOnly === true ? '已暂缓，待补检'
          : (job.processingBasis ? '现有候选后续处理 · ' : '') + (LITERATURE_STATUS_LABELS[job.status] || job.status || '') + (job.stage ? ' · ' + literatureStageLabel(job.stage) : ''), 'literature-history-status'));
        const historyMessage = job.deferredOnly === true ? '当前没有其他待检索来源，已有' + job.count + '条候选可继续处理。'
          : job.processingBasis ? literatureProcessingBasisMessage(job) : String(job.message || '');
        const historyNote = node('span', job.processingBasis ? historyMessage : historyMessage.slice(0, 60), 'literature-history-message');
        historyNote.title = historyMessage; row.append(historyNote);
        if (job.deletedAt) {
          const restore = node('button', '恢复', 'quiet-button'); restore.type = 'button';
          restore.disabled = !!t.literatureHistoryBusy || t.literatureJobsLoading;
          restore.onclick = () => changeLiteratureHistory(mod, job, true); row.append(restore);
        } else {
          const open = node('button', '查看', 'quiet-button'); open.type = 'button'; open.disabled = t.literatureBusy || t.busy;
          open.onclick = () => attachLiteratureJob(mod, job);
          const remove = node('button', '删除', 'quiet-button'); remove.type = 'button';
          remove.disabled = job.status === 'running' || !!t.literatureHistoryBusy || t.literatureJobsLoading;
          remove.title = job.status === 'running' ? '请先停止正在运行的任务' : '从历史列表隐藏，可恢复；文件和进度保留';
          remove.onclick = () => changeLiteratureHistory(mod, job); row.append(open, remove);
        }
        list.append(row);
      });
      box.append(list);
    }
    if (t.literatureJobsError) box.append(node('p', '历史任务列表读取失败：' + t.literatureJobsError, 'codex-error'));
    return box;
  }
  function literaturePanel(mod, t, container = panel) {
    const box = node('div', undefined, 'literature-connector');
    let timeoutAttention = null;
    const overview = node('div', undefined, 'literature-overview');
    const introduction = node('div');
    introduction.append(node('h3', '文献任务'), node('p', '讨论需求 → 确认设置 → 执行 → 核查结果', 'codex-status'));
    const help = node('button', '使用说明', 'quiet-button'); help.type = 'button';
    help.onclick = () => document.dispatchEvent(new CustomEvent('literature-help-open'));
    overview.append(introduction, help); box.append(overview);
    const row = node('div', undefined, 'codex-toolbar literature-toolbar');
    const prepare = node('button', t.literatureBusy ? '处理中…' : '从对话整理规则', 'quiet-button');
    prepare.type = 'button'; prepare.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy(); prepare.onclick = () => prepareLiterature(mod); row.append(prepare);
    if (!t.literatureConfig) {
      const manual = node('button', '手动填写', 'quiet-button'); manual.type = 'button'; manual.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      manual.onclick = () => manualLiterature(mod); row.append(manual);
    }
    const job = t.literatureJob;
    const awaitingConfirm = !!job && job.status === 'needs_attention' && job.stage === 'awaiting_confirmation';
    const awaitingAccess = !!job && job.status === 'needs_attention' && !awaitingConfirm;
    const sameConfig = !!job && sameLiteratureConfig(job.config, t.literatureConfig);
    const start = node('button', '确认配置并检索', 'primary-button');
    start.type = 'button'; start.disabled = t.literatureBusy || !!root.LiteratureUI?.isBusy() || t.busy || !t.literatureConfig || (awaitingAccess && sameConfig);
    if (awaitingAccess && sameConfig) start.title = '原任务等待人工处理；请用下方“检查并继续”，保留已有来源的结果。';
    if (awaitingConfirm) start.title = '当前任务停在字段确认关口；本按钮发起一次新检索，继续原任务请用下方“确认并继续提取”。';
    start.onclick = () => startLiterature(mod); row.append(start);
    if (job && ['running', 'needs_attention'].includes(job.status)) {
      const stop = node('button', '停止', 'quiet-button'); stop.type = 'button';
      stop.onclick = async () => {
        try { t.literatureJob = await request('/api/literature/cancel?id=' + encodeURIComponent(t.literatureJob.id), { method: 'POST' }); }
        catch (error) { t.literatureError = error.message; }
        render();
      };
      row.append(stop);
    }
    const canAdvance = !!job && !!job.resumeStage && ['completed', 'failed', 'needs_attention'].includes(job.status)
      && job.status !== 'needs_attention';
    if (canAdvance && !job.cnkiRetryPaperId) {
      const label = job.status === 'completed' ? '继续下一阶段' : job.status === 'failed' ? (job.stage === 'interrupted' ? '继续中断的任务' : '重试当前阶段') : '继续';
      const advance = node('button', label, 'quiet-button'); advance.type = 'button'; advance.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      advance.title = '继续原任务，运行到上方所选阶段；请先选择下一阶段或更后的目标。';
      advance.onclick = () => continueLiterature(mod); row.append(advance);
    }
    if (job?.id) {
      if (job.canReviewFulltext === true) {
        const review = node('button', '复核已保存全文', 'quiet-button'); review.type = 'button';
        review.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        review.title = '仅离线复核缓存，保留原文件和备份；不打开网页、不重新检索或下载。';
        review.onclick = () => reviewLiteratureFulltext(mod); row.append(review);
      }
      const editFields = node('button', '设置提取字段', 'quiet-button'); editFields.type = 'button';
      editFields.disabled = t.literatureBusy || t.busy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
      editFields.onclick = () => openLiteratureFields(mod); row.append(editFields);
    }
    const untilWrap = node('label', '本次做到哪一步');
    const until = node('select'); until.setAttribute('aria-label', '本次运行到');
    LITERATURE_UNTIL_OPTIONS.forEach(([value, title]) => { const option = node('option', title); option.value = value; until.append(option); });
    until.value = t.literatureUntil || 'discover'; until.disabled = t.literatureBusy || t.busy;
    until.onchange = () => { t.literatureUntil = until.value; saved[mod.id] = { ...saved[mod.id], literatureUntil: t.literatureUntil }; persist(); };
    untilWrap.append(until); row.append(untilWrap);
    box.append(row);
    box.append(node('p', '登录流程：需要登录、验证或机构权限时，平台会尝试自动打开本任务的官方页面。请在平台专用检索浏览器操作，它会保存该浏览器的登录状态；普通 Edge/Chrome 的登录不会自动共享。完成后回到本平台点击“检查并继续”，任务才会恢复。', 'codex-status'));
    box.append(node('p', '后台对每次页面加载或候选获取设置1分钟时限，超时后暂停并保留已保存结果；正式检索每页单独计时，依赖准备另行提示。', 'codex-status'));
    if (job?.files?.includes('fulltext/status.json') || job?.resumeStage === 'fulltext') {
      box.append(node('p', '全文获取逐篇处理：同篇文献复用任务页，确认文件和状态已保存后关闭；文件生成或下载中会等待完成，登录、验证、限流或错误时保留原页并暂停。摘要与待补充项不自动重复请求。', 'codex-status'));
    }
    if (job?.processingBasis) box.append(node('p', literatureProcessingBasisMessage(job), 'codex-status'));
    const executionOrder = job ? Array.isArray(job.executionOrder) ? job.executionOrder : job.config?.sources : newLiteratureSourceOrder(t.literatureConfig?.sources);
    if (!job?.processingBasis && Array.isArray(executionOrder) && executionOrder.length) box.append(node('p', (job ? '当前任务执行顺序：' : '新检索执行顺序：')
      + executionOrder.map(source => LITERATURE_SOURCE_LABELS[source] || source).join(' → '), 'codex-status'));
    if (job) {
      const deferred = Array.isArray(job.deferredSources) ? [...new Set(job.deferredSources)].filter(source => job.config?.sources?.includes(source)) : [];
      box.append(node('p', '状态：' + (job.deferredOnly === true ? '已暂缓，当前没有其他待检索来源' : deferred.length && job.status === 'completed' ? '仍有暂缓来源待补检，检索尚未全部完成' : job.message || literatureStageLabel(job.stage) || job.status)
        + (job.status === 'completed' ? ' · ' + job.count + ' 条待复核' : ''), 'codex-status'));
      if (deferred.length) box.append(node('p', '暂缓来源待补检：' + deferred.map(source => LITERATURE_SOURCE_LABELS[source] || source).join('、')
        + '。已有候选保留，检索尚未全部完成；可打开原页面处理后点击“' + (job.deferredOnly === true ? '补检该来源' : '检查并继续') + '”补检。', 'codex-status'));
      const stages = literatureStageBar(job);
      if (stages) box.append(stages);
      if (awaitingConfirm) box.append(node('p', '提取字段等待确认：点击“设置提取字段”，新增或核对表头后确认并继续提取。', 'codex-status'));
    }
    if (job?.status !== 'running' && !job?.deletedAt && Array.isArray(job?.cnkiRetryItems) && job.cnkiRetryItems.length) {
      const retry = node('details', undefined, 'literature-deliverable-group');
      retry.append(node('summary', '逐篇重试知网全文 · ' + job.cnkiRetryItems.length + ' 篇'));
      retry.append(node('p', '选择一篇，按完整题名进入知网正常检索与详情页，再获取全文。每次只处理这一篇；不会重新检索候选、批量重试其他文献或进入数据提取。', 'codex-status'));
      job.cnkiRetryItems.slice(0, 100).forEach(item => {
        const entry = node('div', undefined, 'literature-confirm');
        entry.append(node('p', item.title)); entry.append(node('p', item.reason, 'codex-status'));
        const button = node('button', job.cnkiRetryPaperId === item.id ? '继续这篇知网文献' : '重试这篇知网文献', 'quiet-button'); button.type = 'button';
        button.setAttribute('aria-label', button.textContent + '：' + item.title);
        button.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || (!!job.cnkiRetryPaperId && job.cnkiRetryPaperId !== item.id);
        button.onclick = () => retryLiteratureCnki(mod, item.id); entry.append(button); retry.append(entry);
        if (job.status === 'failed' && job.cnkiRetryPaperId === item.id) {
          const restart = node('button', '重新定位这篇知网文献', 'quiet-button'); restart.type = 'button';
          restart.title = '从本篇的正常知网检索页重新执行一次；保留原窗口，不重跑其他文献。';
          restart.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
          restart.onclick = () => retryLiteratureCnki(mod, item.id, true); entry.append(restart);
        }
      });
      box.append(retry);
    }
    if (awaitingAccess) {
      const attention = node('section', undefined, 'literature-confirm'); attention.setAttribute('aria-live', 'polite');
      if (job.deferredOnly !== true && ((job.resumeStage === 'discover' && job.attention?.reason === 'results_unrecognized'
        && job.message === '当前来源加载超过1分钟，已暂停；已有结果保留。请查看原页面后检查并继续，或暂缓此来源。')
        || (job.resumeStage === 'fulltext' && String(job.message || '').startsWith('全文页面加载超过1分钟')))) timeoutAttention = attention;
      const hasSourcePage = LITERATURE_EXECUTABLE_SOURCES.includes(job.attention?.source);
      const fulltextPaused = job.resumeStage === 'fulltext';
      attention.append(node('h4', job.deferredOnly === true ? '已暂缓，当前没有其他待检索来源' : '当前需要处理：' + (fulltextPaused ? '全文获取' : hasSourcePage ? LITERATURE_SOURCE_LABELS[job.attention.source] : job.resumeStage === 'extract' ? '全文核查与提取确认' : '检索暂停')));
      attention.append(node('p', literatureAttentionMessage(job), 'codex-status'));
      if (t.literatureAutoOpenNotice && job.deferredOnly !== true) attention.append(node('p', t.literatureAutoOpenNotice, 'codex-status'));
      const actions = node('div', undefined, 'literature-confirm-actions');
      if (hasSourcePage || fulltextPaused) {
        const open = node('button', fulltextPaused ? '查看原全文任务页' : job.deferredOnly === true ? '查看原页面' : '打开登录/检索页面', 'quiet-button'); open.type = 'button';
        open.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        open.onclick = () => openLiteratureBrowser(mod);
        actions.append(open);
      }
      const resume = node('button', fulltextPaused ? (job.cnkiRetryPaperId ? '继续这篇知网文献' : '继续获取全文') : job.resumeStage === 'extract' ? '继续提取' : job.deferredOnly === true ? '补检该来源' : '检查并继续', 'primary-button'); resume.type = 'button';
      resume.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameConfig;
      resume.onclick = () => job.cnkiRetryPaperId && fulltextPaused ? retryLiteratureCnki(mod, job.cnkiRetryPaperId)
        : continueLiterature(mod, fulltextPaused ? { until: 'fulltext' } : {});
      actions.append(resume);
      if (fulltextPaused && job.cnkiRetryPaperId && job.cnkiRetryItems?.some(item => item.id === job.cnkiRetryPaperId)) {
        const restart = node('button', '重新定位这篇知网文献', 'quiet-button'); restart.type = 'button';
        restart.title = '从本篇的正常知网检索页重新执行一次；保留原窗口，不重跑其他文献。';
        restart.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        restart.onclick = () => retryLiteratureCnki(mod, job.cnkiRetryPaperId, true); actions.append(restart);
      }
      if (job.deferredOnly === true && Number.isSafeInteger(job.count) && job.count > 0 && !job.deletedAt) {
        const target = LITERATURE_STAGE_ORDER.indexOf(t.literatureUntil) >= LITERATURE_STAGE_ORDER.indexOf('dedupe') ? t.literatureUntil : 'dedupe';
        const targets = { dedupe: '去重', fulltext: '获取全文', extract: '提取', validate: '校验', export: '导出' };
        const available = node('button', '用已有' + job.count + '条候选继续' + targets[target], 'quiet-button'); available.type = 'button';
        available.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameLiteratureDeferralConfig(job.config, t.literatureConfig);
        available.onclick = () => continueAvailableLiterature(mod); actions.append(available);
      }
      if (job.deferredOnly !== true && hasSourcePage && job.resumeStage === 'discover' && job.config?.sources?.includes(job.attention.source)) {
        const defer = node('button', '暂缓此来源，继续其他来源', 'quiet-button'); defer.type = 'button';
        defer.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameLiteratureDeferralConfig(job.config, t.literatureConfig);
        defer.title = '保留当前来源已有候选和页码，先继续其他来源；暂缓来源仍须补检。';
        defer.onclick = () => continueLiterature(mod, { deferSource: job.attention.source }); actions.append(defer);
      }
      attention.append(actions); box.append(attention);
    }
    if (t.literatureConfig) {
      const config = t.literatureConfig;
      const details = node('details', undefined, 'literature-config'); details.open = !awaitingAccess;
      details.append(node('summary', '本次检索设置（点击查看或修改）' + (saved[mod.id]?.literatureSource !== literatureSource(mod) ? ' · 对话已更新' : '')));
      details.append(node('p', '这里是本次任务的要求表。核对检索什么、检索范围和需要提取的字段；修改后再开始执行。', 'codex-status'));
      const fields = node('div', undefined, 'literature-config-fields');
      function input(label, key, type = 'text') {
        const wrap = node('label', label); const field = node('input'); field.type = type;
        if (type === 'number') { field.min = '1800'; field.max = String(new Date().getFullYear() + 1); }
        field.value = config[key] ?? ''; field.oninput = () => { config[key] = type === 'number' ? (field.value ? Number(field.value) : null) : field.value; persistConfig(); };
        wrap.append(field); fields.append(wrap);
      }
      function lines(label, key) {
        const wrap = node('label', label); const field = node('textarea'); field.rows = 2; field.value = (config[key] || []).join('\n');
        field.oninput = () => { config[key] = field.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); persistConfig(); };
        wrap.append(field); fields.append(wrap);
      }
      function persistConfig() { saved[mod.id] = { ...saved[mod.id], literatureConfig: config }; persist(); }
      function resetDiscoverBudget() {
        if (config.limits) { config.limits = { ...config.limits }; delete config.limits.discover; }
      }
      input('研究主题', 'topic'); input('默认检索式（未单独填写的来源沿用）', 'query');
      const modeWrap = node('label', '运行模式'); const mode = node('select'); mode.setAttribute('aria-label', '文献检索运行模式');
      if (!config.searchMode) { const legacy = node('option', '历史任务（按原数量）'); legacy.value = ''; mode.append(legacy); }
      [['test', '测试运行（每来源10条）'], ['formal', '正式检索（检索到末页）']].forEach(([value, label]) => {
        const option = node('option', label); option.value = value; mode.append(option);
      });
      mode.value = config.searchMode || ''; mode.disabled = t.literatureBusy || t.busy;
      mode.onchange = () => {
        if (!['test', 'formal'].includes(mode.value)) return;
        config.searchMode = mode.value; config.stopMode = mode.value === 'formal' ? 'end' : 'count'; config.perSourceLimit = mode.value === 'formal' ? null : 10; config.limit = 10;
        if (config.batch) config.batch = { ...config.batch, size: 10 };
        resetDiscoverBudget(); persistConfig(); render();
      };
      modeWrap.append(mode); fields.append(modeWrap);
      const quantity = !config.searchMode ? '历史配置保持原数量：每来源每批最多 ' + (config.batch?.size ?? config.limit ?? 10) + ' 条。继续原任务不会改变数量；切换模式将用于新检索。'
        : config.searchMode === 'formal' && config.stopMode !== 'end' ? '历史正式配置保持原数量：每来源候选上限 ' + (config.perSourceLimit ?? 100) + ' 条。继续原任务沿用原上限；发起新的正式检索会改为检索到可访问末页，不混用旧结果。'
        : config.searchMode === 'formal' ? '正式检索：自动翻页，直到各来源数据库当前可访问末页，不按候选数量停止。遇到登录、验证、网站访问限制或其他问题时暂停并保留已有结果；可访问末页不代表主题相关文献已全部获取。'
        : '测试运行：每个来源最多取10条候选，用于检查检索词和流程；不会自动扩大到正式数量。';
      details.append(node('p', quantity, 'codex-status'));
      const sources = node('div', undefined, 'literature-sources'); sources.append(node('span', '检索来源（六个来源均可选择，按研究需要勾选）'));
      newLiteratureSourceOrder(Object.keys(LITERATURE_SOURCE_LABELS)).forEach(value => {
        const label = LITERATURE_SOURCE_LABELS[value];
        const wrap = node('label', label); const check = node('input'); check.type = 'checkbox'; check.checked = config.sources.includes(value);
        check.disabled = t.literatureBusy || t.busy;
        check.onchange = () => { config.sources = check.checked ? [...new Set([...config.sources, value])] : config.sources.filter(source => source !== value); resetDiscoverBudget(); persistConfig(); render(); };
        wrap.prepend(check); sources.append(wrap);
      });
      fields.append(sources);
      newLiteratureSourceOrder(config.sources).forEach(source => {
        const wrap = node('label', (LITERATURE_SOURCE_LABELS[source] || source) + ' 检索式（留空沿用默认）');
        const field = node('textarea'); field.rows = 2; field.maxLength = 2000;
        field.value = config.sourceQueries?.[source] || ''; field.disabled = t.literatureBusy || t.busy;
        const examples = {
          'google-scholar': '例如：broiler "heat stress" "growth performance"',
          cnki: '例如：肉鸡 热应激 增重',
          wanfang: '例如：肉鸡 高温 生长性能',
          'web-of-science': '例如：(broiler OR broilers) AND ("heat stress" OR "high temperature") AND growth',
          scopus: '例如：(broiler OR broilers) AND ("heat stress" OR "high temperature") AND growth（Documents：Title Abstract Keywords）',
          pubmed: '例如：(broiler[Title/Abstract] OR broilers[Title/Abstract]) AND "heat stress"[Title/Abstract]'
        };
        field.placeholder = examples[source] || '';
        field.oninput = () => {
          config.sourceQueries = { ...(config.sourceQueries || {}) };
          if (field.value.trim()) config.sourceQueries[source] = field.value;
          else delete config.sourceQueries[source];
          persistConfig();
        };
        wrap.append(field); fields.append(wrap);
      });
      input('发表年份起', 'publicationYearFrom', 'number'); input('发表年份止', 'publicationYearTo', 'number');
      input('地域（需写入检索式才用于检索）', 'geography'); input('语言（供后续筛选）', 'language');
      lines('研究类型（每行一项）', 'studyTypes'); lines('纳入规则（每行一项）', 'inclusion');
      lines('排除规则（每行一项）', 'exclusion'); lines('目标参数字段（每行一项）', 'targetFields');
      details.append(fields); box.append(details);
      if (config.sources.some(source => !LITERATURE_EXECUTABLE_SOURCES.includes(source))) box.append(node('p', '配置含无法识别的来源，请重新选择本次检索来源。', 'codex-error'));
      if (job && !sameConfig) box.append(node('p', '当前设置与已有任务的冻结配置不同。继续旧任务请从历史任务重新载入；确认新设置并检索会创建新任务，不混用旧结果。', 'codex-status'));
    } else box.append(node('p', '先在本模块对话确认规则，再点“从对话整理规则”。AI 生成的是候选配置，需你核对后才会执行。', 'codex-status'));
    if (!job) box.append(node('p', '已接入 Google Scholar、中国知网、万方、Web of Science 核心合集、Scopus 和 PubMed，按研究需要选择来源。PubMed 公开检索通常无需登录；其他来源需要登录、验证或机构权限时暂停，请在官方页面操作后继续。全文提取前需要你确认参数字段含义与单位。', 'codex-status'));
    if (job) {
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
    if (timeoutAttention && typeof timeoutAttention.scrollIntoView === 'function') {
      const event = Array.isArray(job.events) ? job.events[job.events.length - 1] : null;
      const stamp = JSON.stringify([job.id, job.attention?.source || '', event?.at || '', job.message]);
      const revealed = saved[mod.id]?.literatureTimeoutReveals || {};
      if (revealed[job.id] !== stamp) {
        timeoutAttention.scrollIntoView({ block: 'center', behavior: 'smooth' });
        saved[mod.id] = { ...saved[mod.id], literatureTimeoutReveals: { ...revealed, [job.id]: stamp } }; persist();
      }
    }
  }
  async function reply(module, messages) {
    const t = task(module.id);
    if (t.busy) throw new Error('文件上传或 Codex 任务正在进行');
    const executeRequested = t.executeOnce || t.execute;
    const plotPlan = module.type === 'plotting' && executeRequested ? t.preparedPlotPlan : undefined;
    if (module.type === 'plotting' && executeRequested && !plotPlan) throw new Error('请在绘图方案中审核后点击生成');
    t.preparedPlotPlan = null;
    t.executeOnce = false;
    t.plotGenerating = !!plotPlan;
    t.busy = true; t.error = ''; t.job = null; render();
    try {
      const sid = await session(module.id);
      const batch = saved[module.id]?.inputBatch;
      if (module.type === 'calculation') {
        const sources = Store.getUpstreamModules(module.id).map(up => {
          const rules = root.TaskManager?.rulesForModule(up.id);
          const text = rules?.text || (up.doc?.status === 'approved' ? up.doc.content : '');
          return text ? {name:up.name, text, version:rules?.text ? rules.version : null} : null;
        }).filter(Boolean);
        if (sources.length) messages = [{role:'user', text:'三条并列准备路径中已有的已确认来源说明（仅作为来源上下文；不代表输入文件已导入或允许直接执行，计算仍依据本模块确认的方案）：\n' + sources.map(up => up.name + (up.version ? ' · 规则 v' + up.version : '') + '\n' + up.text.slice(0, 4000)).join('\n\n')}, ...messages];
      }
      if (module.type === 'clean-data' && batch) messages = [{ role: 'user', text: '当前下载交接批次（来源信息，不替代本模块的清洗规则）：\n仅处理以下当前输入文件，其他 input 文件为历史保留，不自动合并：\n' + batch.names.join('\n') + '\n获取依据：' + batch.label + '\n' + batch.text.slice(0, 1500) }, ...messages];
      const job = await request('/api/codex/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, module: { type: module.type, mode: module.mode }, messages, execute: executeRequested, model: t.model || null, ...(plotPlan ? {plotPlan} : {}) }) });
      if (plotPlan) { t.plotSelectedRunId = job.id; saved[module.id].plotSelectedRunId = job.id; Store.setModuleStatus(module.id,'doing'); }
      saved[module.id].jobId = job.id; persist();
      await watch(module.id, job.id);
    } finally { t.busy = false; t.plotGenerating = false; render(); }
  }
  async function prepareConfirmedExecution(id) {
    const t = task(id);
    if (t.busy) throw new Error('当前文件或 AI 任务尚未完成');
    if (t.backend !== 'codex') throw new Error('请先选择本机 Codex');
    const sid = await session(id);
    t.files = (await request('/api/codex/files?session=' + sid)).files;
    const mod = Store.getState().modules.find(item => item.id === id);
    if (!t.files.some(file => file.group === 'input')) { render(); return false; }
    if (mod?.type === 'plotting') {
      const basis = root.TaskManager?.rulesForModule(id);
      const inputNames = plotInputNames(id);
      if (!basis?.text || !inputNames.length) throw new Error('请先上传并选择绘图数据，审核绘图方案后再生成');
      t.preparedPlotPlan = {text:basis.text, version:basis.version, inputNames, previousRunId:t.plotSelectedRunId || saved[id]?.plotSelectedRunId || undefined};
    }
    if (mod?.type === 'calculation' && !t.files.some(file => /\.(py|r|jl|m|ipynb)$/i.test(file.name) && file.group === 'input')) throw new Error('请先上传计算代码');
    if (mod?.type === 'calculation' && !t.files.some(file => /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name) && file.group === 'input')) throw new Error('请先上传输入数据');
    t.execute = false;
    t.executeOnce = true;
    render();
    return true;
  }
  function cancelPreparedExecution(id) { task(id).executeOnce = false; task(id).preparedPlotPlan = null; render(); }
  function plotInputNames(id) {
    const all = task(id).files.filter(file => file.group === 'input' && /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name)).map(file=>file.name);
    const chosen = saved[id]?.plotInputNames;
    return Array.isArray(chosen) ? all.filter(name=>chosen.includes(name)) : all;
  }
  async function loadPlotRuns(id) {
    const t = task(id); if (t.plotRunsLoading) return;
    t.plotRunsLoading = true;
    try { const sid = await session(id); t.plotRuns = (await request('/api/codex/plots?session='+sid)).runs; t.plotError = ''; }
    catch (error) { t.plotRuns = t.plotRuns || []; t.plotError = '绘图记录读取失败：'+error.message+'。若刚更新网页，请重新运行工作台启动器。'; }
    finally { t.plotRunsLoading = false; render(); }
  }
  function plotPanel(mod,t) {
    const box = node('section',undefined,'plotting-results');
    const title = node('div',undefined,'codex-toolbar'); title.append(node('h3','图表预览与版本'));
    const plan = node('button','查看方案 / 生成图表','primary-button'); plan.type='button'; plan.disabled=t.busy;
    plan.onclick=()=>root.TaskManager?.openPlan(); title.append(plan); box.append(title);
    box.append(node('p','上传数据 → 对话讨论 → 审核绘图方案 → 生成预览。修改时选中一版图讨论，修订方案后重新生成；图片、代码和绘图数据分别下载。','codex-status'));
    const inputs = t.files.filter(file=>file.group==='input' && /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name));
    const selected = plotInputNames(mod.id);
    if (inputs.length) {
      const data = node('details'); data.open=true; data.append(node('summary','本次绘图使用的数据 · '+selected.length));
      inputs.forEach(file=>{
        const label = node('label'); const check = node('input'); check.type='checkbox'; check.checked=selected.includes(file.name); check.disabled=t.busy;
        check.onchange=()=>{ const values = new Set(plotInputNames(mod.id)); check.checked ? values.add(file.name) : values.delete(file.name); saved[mod.id] = {...saved[mod.id],plotInputNames:[...values]}; persist(); render(); };
        label.append(check,document.createTextNode(file.name.replace(/^[0-9a-f]{8}-/,''))); data.append(label);
      }); box.append(data);
    }
    if (t.plotRuns === undefined && !t.plotRunsLoading) void loadPlotRuns(mod.id);
    const runs = t.plotRuns || [];
    if(t.plotGenerating && runs.length) box.append(node('p','正在生成新版本；已完成的历史图和下载文件保留在下方。','codex-status'));
    if (!runs.length) box.append(node('p',t.plotRunsLoading ? '正在读取绘图版本…' : t.plotGenerating ? '正在按审核方案生成图表；完成后会显示预览和下载文件。进度见下方执行记录。' : '还没有生成图表。先与 AI 讨论，再打开上方绘图方案审核并生成。','codex-status'));
    else {
      const chosen = t.plotSelectedRunId || saved[mod.id]?.plotSelectedRunId;
      const run = runs.find(item=>item.id===chosen) || runs[0];
      const label = node('label','查看绘图版本 '); const select = node('select'); select.setAttribute('aria-label','查看绘图版本');
      runs.forEach((item,i)=>{ const option = node('option','第'+(runs.length-i)+'版 · 方案v'+item.planVersion+' · '+new Date(item.createdAt).toLocaleString('zh-CN')+' · '+({completed:'已生成',failed:'未完成',running:'生成中',cancelled:'已停止',interrupted:'已中断'}[item.status]||item.status)); option.value=item.id; select.append(option); });
      select.value=run.id; select.disabled=t.busy;
      select.onchange=()=>{ t.plotSelectedRunId=select.value; saved[mod.id]={...saved[mod.id],plotSelectedRunId:select.value}; persist(); render(); }; label.append(select); box.append(label);
      box.append(node('p','方案 v'+run.planVersion+' · 输入 '+run.inputFiles.length+' 个 · 模型 '+(run.model||'待执行')+' · '+run.id.slice(0,8),'plotting-meta'));
      if (run.error) box.append(node('p',run.error,'codex-error'));
      const images=run.files.filter(file=>/\.(png|jpe?g|webp)$/i.test(file.name));
      images.forEach(file=>{ const image=node('img',undefined,'plotting-preview'); image.alt='绘图预览：'+file.name.split('/').pop(); image.src='/api/codex/preview?session='+saved[mod.id]?.sessionId+'&name='+encodeURIComponent(file.name); image.loading='lazy'; const full=node('a'); full.href=image.src; full.target='_blank'; full.rel='noopener'; full.title='点击查看大图'; full.append(image); box.append(full); });
      if (!images.length) box.append(node('p','本版尚无可预览图片，请检查状态或日志。','codex-status'));
      const downloads=node('div',undefined,'plotting-downloads');
      run.files.forEach(file=>{ const link=node('a',file.name.split('/').pop()+' · '+Math.ceil(file.size/1024)+'KB'); link.href='/api/codex/download?session='+saved[mod.id]?.sessionId+'&group=output&name='+encodeURIComponent(file.name); downloads.append(link); }); box.append(downloads);
      const feedback=node('textarea',undefined,'plotting-feedback'); feedback.rows=3; feedback.placeholder='例如：按物种分面、字号加大、图例移到下方。涉及分组或统计口径的修改也请明确说明。'; feedback.setAttribute('aria-label','这版图的修改意见'); feedback.value=saved[mod.id]?.plotFeedback||''; feedback.disabled=t.busy;
      feedback.oninput=()=>{ saved[mod.id]={...saved[mod.id],plotFeedback:feedback.value}; persist(); };
      const discuss=node('button','讨论这版怎么改','quiet-button'); discuss.type='button'; discuss.disabled=t.busy;
      discuss.onclick=()=>{
        if (!feedback.value.trim()) { t.plotError='请先填写这版图的修改意见。'; render(); return; }
        const mode=document.getElementById('conversation-mode'); mode.value='ai'; mode.dispatchEvent(new Event('change'));
        const sent=ModuleSpace.sendText('请查看绘图版本 '+run.id+'（方案v'+run.planVersion+'）的图片、代码和绘图数据，讨论以下修改意见并给出修订后的完整绘图方案。保留未改变的已确认要求，现在只讨论，不运行或改写文件：\n'+feedback.value.trim());
        if (!sent) { t.plotError='当前无法发送，请先处理输入框中的文字或等待任务结束。'; render(); }
      }; box.append(feedback,discuss);
    }
    if(t.plotError) box.append(node('p',t.plotError,'codex-error'));
    panel.append(box);
  }
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
    if (mod.doc && (mod.doc.status !== 'approved' || sourceType === 'rules')) return null;
    if (!sourceType && mod.doc?.status === 'approved') return { text: mod.doc.content, label: '已审核下载方案', sourceType: 'doc' };
    if (sourceType !== 'doc') {
      const rules = root.TaskManager?.rulesForModule(mod.id);
      if (rules?.text) return { text: rules.text, label: '已确认下载规则 v' + rules.version, sourceType: 'rules' };
    }
    if (mod.doc?.status === 'approved') return { text: mod.doc.content, label: '已审核下载方案', sourceType: 'doc' };
    return null;
  }
  function openDownload(mod, basis) {
    if (mod?.type !== 'download-data') return false;
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
    const current = Store.getState().modules.find(mod => mod.id === id);
    const approved = current && basisForDownload(current, basis.sourceType);
    if (!approved || approved.text !== basis.text) { status.textContent = '下载方案已变化，请重新审核并打开下载窗口。'; return; }
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
    if (mod.type === 'download-data') {
      panel.append(node('h3', '按方案下载数据'));
      panel.append(node('p', '讨论并审核下载方案 → 核对实际文件地址 → 开始下载 → 检查文件与来源。每次最多5个公开文件，每个20MB；数据库查询页面需先取得实际导出文件地址。', 'codex-status'));
    }
    if (mod.type === 'calculation') panel.append(node('p', '输入可来自下载数据、数据清洗、文献挖掘中的一条或多条路径。将本次需要的成果文件上传到此处，再确定计算方式与方案。', 'codex-status'));
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
      literaturePanel(mod, t);
      if (t.error) panel.append(node('p', t.error, 'codex-error'));
      return;
    }
    if (t.backend === 'api' && mod.type !== 'download-data') { panel.append(node('p', 'API 模式提供文字指导；文件上传与实际执行需切换本机 Codex。')); return; }
    if (mod.type !== 'download-data' && account?.error) panel.append(node('p', account.error + '；请打开左下角设置检查连接。', 'codex-error'));
    else if (mod.type !== 'download-data' && account && !account.loggedIn) panel.append(node('p', '请打开左下角设置，登录本机 Codex。', 'codex-error'));
    if (!['download-data', 'clean-data', 'calculation', 'result-audit', 'plotting'].includes(mod.type)) {
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
      input.setAttribute('aria-label', mod.type === 'calculation' ? '上传计算代码和输入数据' : mod.type === 'plotting' ? '上传绘图数据' : '上传清洗原始文件');
      input.onchange = () => upload(mod.id, Array.from(input.files)); fileRow.append(input);
    }
    const refreshButton = node('button', '刷新文件', 'quiet-button'); refreshButton.type = 'button'; refreshButton.disabled = t.busy; refreshButton.onclick = () => refresh(mod.id); fileRow.append(refreshButton);
    if (mod.type === 'download-data') {
      const start = node('button', '按方案开始下载', 'primary-button'); start.type = 'button'; start.disabled = t.busy || !basisForDownload(mod) || !!root.LiteratureUI?.isBusy(); start.onclick = () => openDownload(mod); fileRow.append(start);
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
    panel.append(fileRow);
    if (mod.type === 'plotting') plotPanel(mod,t);
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
