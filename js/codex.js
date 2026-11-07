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
  const literatureFieldsAssistWatchers = new Set();
  let literatureMaterialsDialog = null;
  let literatureHistoryDetailsDialog = null;
  let literatureNewTaskDialog = null;
  let literatureSegmentDialog = null;
  const literatureWorkspaceManagers = new Map();
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
  function persist() { try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {} root.LiteratureDiscussions?.schedule?.(Store.getState().activeModuleId); }
  function task(id) {
    if (!tasks[id]) tasks[id] = { files: [], busy: false, backend: saved[id]?.backend || preferences.backend || 'codex', model: saved[id]?.model ?? preferences.model ?? '', execute: false, executeOnce: false, error: '', job: null, filesOpen: false, logOpen: false,
      literatureConfig: saved[id]?.literatureConfig || null,
      literatureConfigOpen: typeof saved[id]?.literatureConfigOpen === 'boolean' ? saved[id].literatureConfigOpen : null,
      literatureRuleReview: saved[id]?.literatureRuleReview || null,
      literatureConfigNotice: saved[id]?.literatureConfigNotice || '',
      literatureReviewNeedsSync: saved[id]?.literatureReviewNeedsSync === true,
      literaturePreparePending: saved[id]?.literaturePreparePending || null,
      literatureJob: null, literatureBusy: false, literatureError: '',
      literatureUntil: saved[id]?.literatureUntil || 'discover', literatureJobs: null, literatureJobsTried: false, literatureJobsLoading: false, literatureJobsError: '', literatureIncludeDeleted: false, literatureHistoryBusy: null,
      literatureConfirmJob: null, literatureConfirmDrafts: null };
    return tasks[id];
  }
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  async function request(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', ...(options.headers || {}) } }); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { transport: true, endpoint: url, method: options.method || 'GET' }); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '本地服务请求失败'), { status: response.status, code: data.code, sessionId: data.sessionId });
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
      t.cleanResultsKey = null;
      if (Store.getState().modules.find(mod => mod.id === id)?.type === 'clean-data') await loadCleanAcceptanceRuns(id, true);
      if (Store.getState().modules.find(mod => mod.id === id)?.type === 'plotting') await loadPlotRuns(id);
      t.error = '';
    } catch (error) {
      const mod=Store.getState().modules.find(item=>item.id===id);
      if (mod?.type!=='clean-data' || !noteUnavailableCleanSession(id,saved[id]?.sessionId,error)) t.error=error.message;
    }
    render();
  }
  async function syncCleanRuleUpdate(id) {
    const t=task(id),sid=saved[id]?.sessionId,projectId=root.TaskManager?.currentTaskId?.();
    const mod=Store.getState().modules.find(item=>item.id===id);
    if (!sid || mod?.type!=='clean-data' || !root.TaskManager?.applyCleanRuleUpdate) return { applied:false, reason:'not_applicable' };
    if (t.cleanRuleSyncPromise) return t.cleanRuleSyncPromise;
    const current=()=>saved[id]?.sessionId===sid && (!projectId || root.TaskManager?.currentTaskId?.()===projectId)
      && Store.getState().activeModuleId===id && Store.getState().modules.some(item=>item.id===id && item.type==='clean-data');
    const operation=(async()=>{
      const data=await request('/api/codex/clean/rule-update?session='+encodeURIComponent(sid));
      if (!current()) throw Object.assign(Error('任务或模块已切换，规则更新保留在原任务，未覆盖当前内容'),{code:'CLEAN_SYNC_CONTEXT_CHANGED'});
      if (!data.update) return { applied:false, reason:'no_update' };
      if (data.update.sessionId!==sid) throw Error('规则更新与当前文件会话不一致，原内容保留');
      const result=root.TaskManager.applyCleanRuleUpdate(id,data.update);
      if (!result?.applied && !result?.unchanged) {
        const reasons={'busy-or-editing':'当前有任务或核验草稿正在编辑，原规则和草稿保留；请结束当前操作后执行',
          'draft-changed':'当前有尚未保存的规则草稿，更新未覆盖草稿',
          'approved-rules-changed':'当前已确认规则的正文与授权更新不同，原版本保留',
          'storage-failed':'浏览器未能保存新规则版本，已回滚保留旧版',
          'invalid-resolution':'页面未能核对A规则更新，原版本保留，请重新加载本页'};
        throw Error(result?.message || reasons[result?.reason] || '当前任务与待同步的A规则不匹配，原规则和讨论保留');
      }
      const inputName=data.update.binding.inputName;
      saved[id]={...saved[id],cleanStandardNames:[...new Set([...cleanStandardNames(id).filter(name=>name!==data.update.binding.sourceName && name!==inputName),...(data.update.standardFiles || []).map(file=>file.name)])],
        inputBatch:{...(saved[id]?.inputBatch || {}),names:[inputName],label:'A规则已绑定的80条原始数据',text:'原件保留；版本和SHA-256已写入当前执行规则。'},cleanRuleUpdateId:data.update.id};
      persist();t.cleanRuleSyncError='';t.cleanRuleSyncNotice='A规则已同步为执行版，输入版本与异常策略已落实；原规则历史及讨论保留。';
      try { await request('/api/codex/clean/rule-update-ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,updateId:data.update.id,afterSha256:data.update.afterSha256,version:result.version,moduleId:id,projectId})}); }
      catch(error) { t.cleanRuleSyncNotice+=' 当前规则已在浏览器保存，服务端回执暂未收到，刷新时会重试。'; }
      return result;
    })();
    t.cleanRuleSyncPromise=operation;
    try { return await operation; }
    catch(error) { if(current())t.cleanRuleSyncError=error.message;throw error; }
    finally { if(t.cleanRuleSyncPromise===operation)t.cleanRuleSyncPromise=null; }
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
    const initial = node('option', '工作台默认 · ' + (account?.model || '登录后显示')); initial.value = ''; modelPicker.append(initial);
    (account?.models || []).forEach(item => { const option = node('option', item.displayName || item.model); option.value = item.model; modelPicker.append(option); });
    if (t.model && !(account?.models || []).some(item => item.model === t.model)) { const option = node('option', t.model + '（当前不可用，请重新选择）'); option.value = t.model; option.disabled = true; modelPicker.append(option); }
    modelPicker.value = t.model || ''; modelPicker.disabled = !!t.busy || checking || !account?.loggedIn;
    loginButton.textContent = account?.loggedIn ? '本机 Codex 已连接' : '登录本机 Codex'; loginButton.disabled = loginBusy || !!t.busy;
    refreshButton.disabled = checking;
    const connectionError = /workspace routing discovery (?:failed|timed out)/i.test(account?.error || '') ? 'Codex 工作区连接失败，请检查本机网络与 Codex 连接后重试。' : account?.error;
    connectionStatus.textContent = checking ? '检查连接中…' : loginNotice || connectionError || (account?.loggedIn ? '本机 Codex 已登录 · ' + (account.models || []).length + ' 个模型' + (account.effort ? ' · 推理 ' + account.effort : '') : '未连接，请先安装 Codex CLI 并点击登录');
    document.querySelectorAll('[data-api-settings]').forEach(item => { item.hidden = backendPicker.value !== 'api'; });
  }
  function saveConnection() {
    const id = Store.getState().activeModuleId;
    preferences = { backend: backendPicker.value, model: modelPicker.value };
    if (id) {
      const t = task(id); Object.assign(t, preferences); saved[id] = { ...saved[id], ...preferences };
      if (Store.getState().modules.find(mod => mod.id === id)?.type === 'literature-mining' && t.literatureConfig) {
        t.literatureConfig.extraction = { ...t.literatureConfig.extraction, model: preferences.model || account?.model || null };
        saved[id].literatureConfig = t.literatureConfig;
      }
      persist();
    }
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
  function cleanStandardNames(id) {
    return [...new Set((Array.isArray(saved[id]?.cleanStandardNames) ? saved[id].cleanStandardNames : []).filter(name=>typeof name==='string' && name && !/[\\/\x00-\x1f]/.test(name)))];
  }
  async function uploadCleanStandards(mod, files) {
    const t=task(mod.id);
    if (!files.length || t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy()) return false;
    const projectId=root.TaskManager?.currentTaskId?.();
    const current=()=>Store.getState().modules.some(value=>value.id===mod.id && value.type==='clean-data') && (!projectId || root.TaskManager?.currentTaskId?.()===projectId);
    t.busy=true;t.cleanStandardError='';t.preparedCleanPlan=null;t.executeOnce=false;render();
    try {
      if (!current()) throw new Error('当前项目已改变，请在原清洗模块上传标准。');
      const sid=await session(mod.id);
      for (const file of files) {
        if (!current()) throw new Error('项目已改变；已上传的标准原件保留，不继续上传。');
        if (!/\.(md|txt|pdf|docx|csv|tsv|xlsx|xls|json)$/i.test(file.name) || file.size>20*1024*1024) throw new Error('标准原件支持 MD、TXT、PDF、DOCX、CSV、TSV、Excel、JSON，每份不超过20MB。');
        const result=await request('/api/codex/upload?session='+encodeURIComponent(sid)+'&group=reference&name='+encodeURIComponent(file.name),{method:'POST',body:file});
        if (!current() || saved[mod.id]?.sessionId!==sid) throw new Error('项目或会话已改变；上传原件保留在原任务，未应用到当前页面。');
        t.files=Array.isArray(result.files) ? result.files : t.files;
        if (!result.name) throw new Error('未收到标准原件名称，请刷新文件后核对。');
        saved[mod.id]={...saved[mod.id],cleanStandardNames:[...new Set([...cleanStandardNames(mod.id),result.name])]};delete saved[mod.id].cleanHandoff;Store.invalidateCleanAcceptance?.(mod.id,null,'人工标准原件已改变，请纳入同一方案并重新确认');persist();
      }
      t.cleanStandardNotice='标准原件已保留，尚未采纳。点击“讨论清洗核验”，将采用的要求写入同一方案并确认；文件不会当作待清洗数据。';return true;
    } catch(error) {t.cleanStandardError=error.message;return false;}
    finally {t.busy=false;render();ModuleSpace.render();}
  }
  async function watch(id, jobId) {
    const t = task(id); t.busy = true;
    try {
      while (true) {
        const job = await request('/api/codex/job?id=' + jobId + '&session=' + encodeURIComponent(saved[id]?.sessionId || ''));
        t.job = job; t.files = job.files; render();
        if (job.status !== 'running') {
          if (job.stage && Store.getState().modules.find(mod => mod.id === id)?.type === 'clean-data') {
            t.cleanResultsRunId = job.id;
            t.cleanResultsKey = null;
          }
          if (saved[id]?.delivered !== job.id) {
            if (job.text) Store.appendMessage(id, job.text, 'assistant');
            if (job.status !== 'completed') Store.appendMessage(id, 'Codex：' + (job.error || (job.status === 'needs_attention' ? '有待确认事项，请补充规则后再执行。' : job.status === 'cancelled' ? '任务已停止，部分输出请检查后使用。' : '任务未完成')), 'system');
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
          if (Store.getState().modules.find(mod => mod.id === id)?.type === 'clean-data') {
            // A completed conversation is not necessarily a cleaning execution.
            // Only the backend's frozen/legacy run list can select this job.
            await loadCleanAcceptanceRuns(id, true, job.id);
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
    if (job.files?.includes('fulltext/status.json')) return literatureStatusText(job) + literatureProcessingBasisMessage(job);
    const candidateCount = Number.isSafeInteger(job.counters?.candidates) ? job.counters.candidates : job.count;
    const base = '候选检索已保存 ' + candidateCount + ' 条待复核记录；这不是已纳入文献，也未提取全文。可在文献检索区下载清单。';
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
  function literatureStatusText(job) {
    if (job.status !== 'completed' || !job.files?.includes('fulltext/status.json')) return String(job.message || '');
    const counters = job.counters || {}, parts = [];
    const hasCount = value => Number.isSafeInteger(value) && value >= 0;
    if (job.files.includes('export/literature.xlsx') || job.files.includes('export/literature.csv')) {
      const count = hasCount(counters.uniqueGroups) ? counters.uniqueGroups : counters.candidates;
      parts.push('文献表已导出' + (hasCount(count) ? '：' + count + ' 条文献记录' : ''));
      parts.push('参数明细表已导出' + (hasCount(counters.parameterRows) ? '：' + counters.parameterRows + ' 行' : ''));
    } else parts.push(literatureDeliverableSummary(job) || '本轮材料处理已结束');
    if (hasCount(counters.fulltextFetched)) {
      let body = '已获取正文 ' + counters.fulltextFetched + ' 篇';
      const formats = [];
      if (hasCount(counters.fulltextPdf)) formats.push('PDF ' + counters.fulltextPdf + ' 篇');
      if (hasCount(counters.fulltextHtml)) formats.push('网页正文 ' + counters.fulltextHtml + ' 篇');
      if (formats.length) body += '（' + formats.join(' / ') + '）';
      parts.push(body);
    }
    if (hasCount(counters.materialsIncomplete) && counters.materialsIncomplete > 0) parts.push('材料仍有缺口 ' + counters.materialsIncomplete + ' 篇');
    return parts.join('；') + '。';
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
    if (job.status !== 'needs_attention' || job.stage === 'awaiting_confirmation' || job.deferredOnly === true || job.attention?.reason === 'deferred_materials'
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
                ? '提取前需由研究者确认参数字段含义与单位：请在文献检索区核对字段并点击“核对表格并开始提取”。'
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
  function literatureWorkspaceBusy(id) {
    const t = task(id);
    return !!(t.busy || t.literatureBusy || t.literatureJob?.status === 'running' || t.literatureFieldsAssistBusy
      || t.literatureHistoryBusy || t.literatureAutoOpening || root.ModuleSpace?.isBusy() || root.LiteratureUI?.isBusy());
  }
  function literatureWorkspaceManager(mod) {
    if (!root.LiteratureTaskWorkspaces || !root.TaskManager?.currentTaskId) return null;
    const projectId = root.TaskManager.currentTaskId();
    if (!projectId) return null;
    const managerKey = projectId + ':' + mod.id;
    if (!literatureWorkspaceManagers.has(managerKey)) {
      const manager = root.LiteratureTaskWorkspaces.createManager({ moduleId: mod.id, adapter: {
        snapshotClient: () => JSON.parse(JSON.stringify({ ...saved[mod.id], literatureConfig: task(mod.id).literatureConfig,
          literatureUntil: task(mod.id).literatureUntil, literaturePreparePending: task(mod.id).literaturePreparePending || null })),
        applyClient: client => {
          const next = { ...saved, [mod.id]: JSON.parse(JSON.stringify(client || {})) };
          localStorage.setItem(key, JSON.stringify(next));
          const previous = tasks[mod.id];
          if (previous) previous.literatureWatchGeneration = (previous.literatureWatchGeneration || 0) + 1;
          saved = next;
          delete tasks[mod.id];
        },
        isBusy: () => literatureWorkspaceBusy(mod.id),
        closeDialogs: () => {
          const t = task(mod.id);
          if (t.literatureJob?.id && t.literatureConfirmDrafts && !saveLiteratureFieldDrafts(t, t.literatureJob)) {
            throw new Error(t.literatureFieldsError || '字段草稿尚未保存，未切换任务');
          }
          closeLiteratureFields();
          root.LiteratureRuleReview?.close();
          if (literatureMaterialsDialog?.open) literatureMaterialsDialog.close();
        }
      } });
      literatureWorkspaceManagers.set(managerKey, manager);
    }
    return literatureWorkspaceManagers.get(managerKey);
  }
  function literatureNewTaskSeed(mod, mode, reuse) {
    const t = task(mod.id);
    const source = t.literatureConfig || t.literatureJob?.config;
    const config = reuse && source ? JSON.parse(JSON.stringify(source)) : {
      topic: '', query: '', sources: ['google-scholar'], sourceQueries: {}, publicationYearFrom: null, publicationYearTo: null,
      geography: '', language: '', studyTypes: [], inclusion: [], exclusion: [], targetFields: [], limit: 10
    };
    if (reuse && t.literatureJob?.id) {
      const fields = literatureFieldDrafts[t.literatureJob.id]?.fields;
      if (Array.isArray(fields) && fields.length) config.fieldDefinitions = JSON.parse(JSON.stringify(fields));
    }
    config.searchMode = mode === 'formal' ? 'formal' : 'test';
    config.stopMode = mode === 'formal' ? 'end' : 'count';
    config.perSourceLimit = mode === 'formal' ? null : 10;
    config.limit = 10;
    if (mode === 'formal' && config.limits) delete config.limits.discover;
    return { backend: t.backend, model: t.model, literatureConfig: config, literatureUntil: 'discover',
      literatureConfigOpen: false };
  }
  function scholarTrialSeed(current, options = {}) {
    const query = String(options.query || '').trim();
    const yearFrom = Number(options.yearFrom), yearTo = Number(options.yearTo);
    if (!query || query.length > 32768) throw new Error('请填写有效的谷歌学术短查询');
    if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom < 1800 || yearTo > new Date().getUTCFullYear() + 1 || yearFrom > yearTo) throw new Error('请核对预试起止年份');
    const source = current.literatureConfig || current.literatureJob?.config || {};
    const config = JSON.parse(JSON.stringify(source));
    Object.assign(config, { topic: config.topic || '谷歌学术短查询预试', query, sources: ['google-scholar'], sourceQueries: { 'google-scholar': query },
      publicationYearFrom: yearFrom, publicationYearTo: yearTo, searchMode: 'formal', stopMode: 'end', perSourceLimit: null, limit: 10,
      batch: { size: 10, maxBatches: 1 }, scholarPlan: { version: 1, topics: [{ id: 'trial-topic', label: '短查询预试', query }], yearSpan: 5, sort: 'relevance', trialMaxPages: 2 } });
    if (config.limits) delete config.limits.discover;
    return { backend: current.backend, model: current.model, literatureConfig: config, literatureUntil: 'discover', literatureConfigOpen: true };
  }
  async function hydrateLiteratureWorkspace(mod) {
    const t = task(mod.id), jobId = saved[mod.id]?.literatureJobId;
    if (!jobId) { render(); return; }
    t.literatureBusy = true; render();
    try {
      const job = await request('/api/literature/job?id=' + encodeURIComponent(jobId));
      if (task(mod.id) !== t || saved[mod.id]?.literatureJobId !== jobId) return;
      t.literatureJob = job;
      t.literatureError = job.deletedAt ? '该检索记录已删除，可在历史任务中恢复；讨论和配置仍保留。' : '';
      // Loading a context only reads its saved job. Execution and login remain explicit actions.
    } catch (error) { if (task(mod.id) === t) t.literatureError = error.message; }
    finally { if (task(mod.id) === t) { t.literatureBusy = false; render(); } }
  }
  function openNewLiteratureTask(mod) {
    const manager = literatureWorkspaceManager(mod);
    if (!manager || literatureWorkspaceBusy(mod.id)) return;
    const ensured = manager.ensure();
    if (!ensured.ok) { task(mod.id).literatureError = ensured.error; render(); return; }
    if (literatureNewTaskDialog?.open) return;
    const dialog = node('dialog', undefined, 'literature-new-task-dialog');
    const form = node('form');
    form.append(node('h2', '新建文献任务'));
    form.append(node('p', '小样、正式检索或不同主题分别新建。原任务保留，创建后先核对设置，不会立即检索。'));
    const nameLabel = node('label', '任务名称');
    const nameInput = node('input'); nameInput.required = true; nameInput.maxLength = 80;
    nameInput.placeholder = '例如：肉鸡热应激 · 正式检索'; nameLabel.append(nameInput);
    const modeLabel = node('label', '运行模式');
    const modeInput = node('select');
    [['test', '小样测试（每来源10条）'], ['formal', '正式检索（到可访问末页）']].forEach(([value, label]) => {
      const option = node('option', label); option.value = value; modeInput.append(option);
    });
    modeLabel.append(modeInput);
    const reuseLabel = node('label', '初始内容');
    const reuseInput = node('select');
    [['blank', '空白开始（适合其他主题）'], ['reuse', '复用当前规则和表头（需重新核对）']].forEach(([value, label]) => {
      const option = node('option', label); option.value = value; reuseInput.append(option);
    });
    reuseLabel.append(reuseInput);
    const errorText = node('p', '', 'codex-error'); errorText.setAttribute('role', 'alert');
    const actions = node('div', undefined, 'dialog-actions');
    const cancel = node('button', '取消', 'quiet-button'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
    const create = node('button', '创建并核对设置', 'primary-button'); create.type = 'submit';
    actions.append(cancel, create); form.append(nameLabel, modeLabel, reuseLabel,
      node('p', '复用只复制规则和字段草稿，不复制候选、材料、提取结果或审核通过状态。'), errorText, actions);
    form.onsubmit = event => {
      event.preventDefault();
      if (literatureWorkspaceBusy(mod.id)) { errorText.textContent = '当前有任务正在处理，请完成或停止后再新建。'; return; }
      const reuse = reuseInput.value === 'reuse';
      const result = manager.create({ name: nameInput.value, mode: modeInput.value,
        seedClient: literatureNewTaskSeed(mod, modeInput.value, reuse), seedDoc: reuse ? mod.doc : null });
      if (!result.ok) { errorText.textContent = result.error; return; }
      const fresh = Store.getState().modules.find(item => item.id === mod.id);
      saved[mod.id] = { ...saved[mod.id], literatureSource: literatureSource(fresh) }; persist();
      dialog.close(); render(); ModuleSpace.render();
    };
    dialog.append(form); document.body.append(dialog); literatureNewTaskDialog = dialog;
    dialog.addEventListener('close', () => { if (literatureNewTaskDialog === dialog) literatureNewTaskDialog = null; dialog.remove(); });
    dialog.showModal(); nameInput.focus();
  }
  function openScholarTrial(mod) {
    const manager = literatureWorkspaceManager(mod);
    if (!manager || literatureWorkspaceBusy(mod.id) || literatureNewTaskDialog?.open) return;
    const ensured = manager.ensure();
    if (!ensured.ok) { task(mod.id).literatureError = ensured.error; render(); return; }
    const dialog = node('dialog', undefined, 'literature-new-task-dialog'), form = node('form');
    form.append(node('h2', '谷歌学术小范围预试（最多2页，仅候选）'));
    form.append(node('p', '单独保存本次预试，原任务和已有候选保留。只试研究的一小部分，不能代表整个研究已检全；不会下载全文或提取数据。'));
    const name = node('input'); name.required = true; name.maxLength = 80; name.value = '谷歌学术预试 · 肉鸡热应激';
    const query = node('textarea'); query.required = true; query.rows = 2; query.maxLength = 32768; query.value = 'broiler "heat stress"';
    const from = node('input'), to = node('input');
    [from, to].forEach(field => { field.type = 'number'; field.step = '1'; field.required = true; field.min = '1800'; field.max = String(new Date().getUTCFullYear() + 1); });
    from.value = '2020'; to.value = '2024';
    [['预试任务名称', name], ['短查询（可以修改，不改变原研究范围）', query], ['起始年份（可以修改）', from], ['截止年份（可以修改）', to]].forEach(([label, field]) => { const wrap = node('label', label); field.setAttribute('aria-label', label); wrap.append(field); form.append(wrap); });
    form.append(node('p', '创建后请在新工作区核查实际短查询、年份、分批计划和“仅检索候选”；确认后再点开始。创建草稿不会自动确认或启动。'));
    const error = node('p', '', 'codex-error'); error.setAttribute('role', 'alert');
    const actions = node('div', undefined, 'dialog-actions'), cancel = node('button', '取消', 'quiet-button'), create = node('button', '创建预试草稿并核对', 'primary-button');
    cancel.type = 'button'; cancel.onclick = () => dialog.close(); create.type = 'submit'; actions.append(cancel, create); form.append(error, actions);
    form.onsubmit = event => {
      event.preventDefault();
      if (literatureWorkspaceBusy(mod.id)) { error.textContent = '当前任务仍在处理，请完成或停止后再创建预试。'; return; }
      try {
        const seedClient = scholarTrialSeed(task(mod.id), { query: query.value, yearFrom: from.value, yearTo: to.value });
        const result = manager.create({ name: name.value, mode: 'formal', seedClient, seedDoc: null });
        if (!result.ok) { error.textContent = result.error; return; }
        const fresh = Store.getState().modules.find(item => item.id === mod.id);
        saved[mod.id] = { ...saved[mod.id], literatureSource: literatureSource(fresh) }; persist();
        dialog.close(); render(); ModuleSpace.render();
      } catch (failure) { error.textContent = failure.message; }
    };
    dialog.append(form); document.body.append(dialog); literatureNewTaskDialog = dialog;
    dialog.addEventListener('close', () => { if (literatureNewTaskDialog === dialog) literatureNewTaskDialog = null; dialog.remove(); });
    dialog.showModal(); query.focus();
  }
  // 账号与权限：任务开始前先把机构登录/会员购买处理好，避免跑到一半撞登录墙。
  // 平台只打开官方页面，不代填账号、不代付款；2026-11-06 扩到五库 + EZproxy。
  function literatureAccessPanel(t) {
    const box = node('div', undefined, 'literature-access-panel');
    box.append(node('p', '账号与权限（登录一次，后续任务复用）', 'codex-status'));
    const row = node('div', undefined, 'literature-access-actions');
    const busy = () => t.busy || t.literatureBusy;
    const act = async (target, label) => {
      if (busy()) return;
      t.literatureAccessStatus = '正在打开' + label + '…'; render();
      try {
        const result = await request('/api/literature/access-page', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
        t.literatureAccessStatus = '已打开' + (result.label || label) + '；在该页完成登录后点“检查登录状态”。';
      } catch (error) { t.literatureAccessStatus = '打开失败：' + error.message; }
      render();
    };
    const check = async () => {
      if (busy()) return;
      t.literatureAccessStatus = '正在读取登录状态（万方/知网/WoS/Scopus/EZproxy，可能需要一两分钟）…'; render();
      try {
        const result = await request('/api/literature/access-status', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'all' }) });
        const lines = Array.isArray(result.results) && result.results.length
          ? result.results.map(item => item.label + '：' + (item.message || '未判定'))
          : [result.message || (result.signedIn ? '已登录' : '未登录')];
        t.literatureAccessStatus = '当前：' + lines.join('｜');
      } catch (error) { t.literatureAccessStatus = '状态读取失败：' + error.message; }
      render();
    };
    const add = (label, target) => {
      const button = node('button', label, 'quiet-button'); button.type = 'button';
      button.onclick = () => act(target, label); row.append(button);
    };
    add('打开机构登录', 'institution');
    add('知网机构登录', 'cnki');
    add('Web of Science 登录', 'wos');
    add('Scopus 登录', 'scopus');
    add('EZproxy 统一登录', 'ezproxy');
    add('打开万方会员', 'purchase');
    const statusBtn = node('button', '检查登录状态', 'quiet-button'); statusBtn.type = 'button';
    statusBtn.onclick = () => check();
    row.append(statusBtn);
    box.append(row, node('p', t.literatureAccessStatus || '当前：未检测', 'codex-status'),
      node('p', '登录状态保存在平台专用浏览器；普通浏览器不共享。万方勾选“7天免登录”约 7 天，其他库按各自会话有效期，过期需重登。EZproxy 一次登录覆盖已订购资源，但适配器仍需经 EZproxy 地址访问才会带上机构权限。', 'codex-status'));
    return box;
  }

  function literatureTaskSelector(mod, t) {
    const manager = literatureWorkspaceManager(mod);
    if (!manager) return null;
    const ensured = manager.ensure();
    const box = node('div', undefined, 'literature-task-selector');
    const add = node('button', '＋ 新建文献任务', 'quiet-button'); add.type = 'button';
    add.disabled = literatureWorkspaceBusy(mod.id) || !ensured.ok;
    add.onclick = () => openNewLiteratureTask(Store.getState().modules.find(item => item.id === mod.id) || mod);
    if (!ensured.ok) { box.append(add, node('p', ensured.error, 'codex-error')); return box; }
    const label = node('label', '当前文献任务');
    const select = node('select'); select.setAttribute('aria-label', '切换当前项目内的文献任务');
    const active = manager.active();
    manager.list().forEach(context => {
      const option = node('option', context.name + (context.mode === 'formal' ? ' · 正式' : ' · 小样'));
      option.value = context.id; select.append(option);
    });
    select.value = active?.id || ''; select.disabled = literatureWorkspaceBusy(mod.id);
    select.onchange = () => {
      const result = manager.switch(select.value);
      if (!result.ok) { t.literatureError = result.error; render(); return; }
      render(); ModuleSpace.render(); void hydrateLiteratureWorkspace(mod);
    };
    label.append(select); box.append(label, add);
    box.append(literatureAccessPanel(t));
    const trial = node('button', '谷歌学术小范围预试（最多2页，仅候选）', 'quiet-button'); trial.type = 'button';
    trial.disabled = literatureWorkspaceBusy(mod.id);
    trial.onclick = () => openScholarTrial(Store.getState().modules.find(item => item.id === mod.id) || mod); box.append(trial);
    if (root.LiteratureDiscussions) {
      const discussions = node('button', '讨论记录', 'quiet-button'); discussions.type = 'button'; discussions.onclick = () => root.LiteratureDiscussions.open(mod.id);
      const saveDiscussion = node('button', '保存讨论与草稿', 'quiet-button'); saveDiscussion.type = 'button'; saveDiscussion.onclick = () => root.LiteratureDiscussions.save(mod.id, true);
      const saveState = root.LiteratureDiscussions.status(mod.id);
      const discussionStatus = node('p', saveState.text, saveState.error ? 'codex-error' : 'codex-status');
      discussionStatus.setAttribute('data-literature-discussion-scope', root.TaskManager.currentTaskId() + ':' + mod.id + ':' + active.id);
      box.append(discussions, saveDiscussion, discussionStatus);
      const origin = saved[mod.id]?.literatureDiscussionOrigin;
      if (!(mod.messages || []).length) {
        box.append(node('p', '当前文献工作区暂无讨论；这不表示其他工作区的原讨论被删除。点击“讨论记录”查看所有已保存讨论。', 'codex-status'));
        if (origin) { const back = node('button', '回到原讨论', 'primary-button'); back.type = 'button'; back.disabled = literatureWorkspaceBusy(mod.id); back.onclick = () => root.LiteratureDiscussions.returnOrigin(mod.id); box.append(back); }
      }
    }
    if (saved[mod.id]?.literatureDiscussionEditingForJobId) {
      box.append(node('p', '正在继续讨论并修改检索规则。下方发送修改要求后，点击“从对话更新规则并核查”；新草稿保存成功才进入核查。原检索结果保留。', 'codex-status'));
      if (!(mod.messages || []).some(message => message.role === 'user')) box.append(node('p', '当前工作区没有已保存的讨论。可先点“讨论记录”查找旧讨论，或在下方补充修改要求；历史任务详情不会保存完整聊天。', 'codex-error'));
    }
    if (!t.literatureJob?.id && !saved[mod.id]?.literatureJobId) box.append(node('span', '草稿 · 尚未检索', 'codex-status'));
    return box;
  }
  function literatureSegmentSelection(preview, fromStage, until, paperIds) {
    const stages = ['extract', 'validate', 'export'];
    if (!preview?.sourceJobId || !Array.isArray(preview.papers) || !stages.includes(fromStage) || !stages.includes(until)
      || stages.indexOf(until) < stages.indexOf(fromStage) || !preview.allowedStages?.includes(fromStage)) throw new Error('请选择有效的开始与结束阶段。');
    if (!Array.isArray(paperIds) || !paperIds.length || new Set(paperIds).size !== paperIds.length) throw new Error('请至少选择一篇文献，不要重复选择。');
    paperIds.forEach(id => {
      const paper = preview.papers.find(item => item.paperId === id);
      if (!paper || paper.eligible?.[fromStage]?.allowed !== true) throw new Error((paper?.title || id) + '：' + (paper?.eligible?.[fromStage]?.reason || '前置成果尚不能复用'));
    });
    return { sourceJobId: preview.sourceJobId, paperIds: [...paperIds], fromStage, until };
  }
  async function createLiteratureSegmentTask(mod, input) {
    const t = task(mod.id), source = t.literatureJob;
    if (literatureWorkspaceBusy(mod.id) || !source?.id || source.deletedAt) return null;
    let selection;
    try {
      selection = literatureSegmentSelection(input.preview, input.fromStage, input.until, input.paperIds);
      if (selection.sourceJobId !== source.id || !input.requestId) throw new Error('来源任务已变化，请重新打开范围设置。');
    } catch (error) { t.literatureError = error.message; render(); return null; }
    const manager = literatureWorkspaceManager(mod);
    if (!manager) { t.literatureError = '请先载入当前项目的文献任务目录。'; render(); return null; }
    const preserved = manager.saveActive();
    if (!preserved.ok) { t.literatureError = preserved.error; render(); return null; }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(source.config?.sources || []);
      const next = await request('/api/literature/segment-task', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selection, requestId: input.requestId }) });
      const segment = next?.segmentTask;
      if (!next?.id || next.id === source.id || next.status !== 'needs_attention' || next.materialReplenishment
        || segment?.sourceJobId !== source.id || segment.fromStage !== selection.fromStage || segment.until !== selection.until
        || JSON.stringify(segment.paperIds?.slice().sort()) !== JSON.stringify(selection.paperIds.slice().sort())) throw new Error('新任务范围未核对通过；原任务保留，未执行。');
      // Workspace creation snapshots the source and never seeds its output or
      // approval binding. Attach the new paused backend job only afterwards.
      t.literatureBusy = false;
      const known = manager.list().find(item => item.jobId === next.id);
      const result = known ? manager.switch(known.id) : manager.create({
        name: ('已有成果 · ' + literatureStageLabel(segment.fromStage) + '至' + literatureStageLabel(segment.until) + ' · ' + segment.paperIds.length + '篇').slice(0, 80),
        mode: source.config?.searchMode === 'formal' ? 'formal' : 'test',
        seedClient: { backend: t.backend, model: t.model, literatureConfig: JSON.parse(JSON.stringify(next.config || {})), literatureUntil: segment.until, literatureConfigOpen: false } });
      if (!result.ok) throw new Error(result.error + ' 新任务已暂停保存在历史记录：' + next.id);
      const fresh = Store.getState().modules.find(item => item.id === mod.id) || mod;
      attachLiteratureJob(fresh, next);
      const active = task(mod.id);
      if (segment.fromStage === 'extract' && !known) {
        active.literatureConfirmJob = next.id;
        active.literatureConfirmDrafts = JSON.parse(JSON.stringify(input.fieldMode === 'blank' ? [] : input.preview.suggestedFields || next.config?.fieldDefinitions || []));
        saveLiteratureFieldDrafts(active, next);
      }
      manager.saveActive(); render(); ModuleSpace.render();
      if (segment.fromStage === 'extract') openLiteratureFields(fresh);
      return next;
    } catch (error) { task(mod.id).literatureError = error.message; render(); return null; }
    finally { t.literatureBusy = false; }
  }
  async function openLiteratureSegmentDialog(mod) {
    const t = task(mod.id), source = t.literatureJob;
    if (!source?.id || source.deletedAt || literatureWorkspaceBusy(mod.id) || literatureSegmentDialog?.open) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    let preview;
    try {
      preview = await request('/api/literature/segment-preview?id=' + encodeURIComponent(source.id));
      if (task(mod.id) !== t || task(mod.id).literatureJob?.id !== source.id) return;
    } catch (error) { t.literatureError = error.message; render(); return; }
    finally { t.literatureBusy = false; render(); }
    const dialog = node('dialog', undefined, 'literature-help-dialog'); dialog.style.width = 'min(1100px, 94vw)'; dialog.style.maxHeight = '90vh'; dialog.style.overflowY = 'auto';
    dialog.setAttribute('aria-label', '从已有成果开始');
    const form = node('form'); form.append(node('h2', '从已有成果开始'));
    form.append(node('p', '选择已有文献和执行范围，建立独立的暂停任务。原检索、材料、提取和导出保留，不重新检索或下载。'));
    const stages = ['extract', 'validate', 'export'];
    const fromLabel = node('label', '从哪一步开始'), from = node('select'); from.setAttribute('aria-label', '开始阶段');
    const untilLabel = node('label', '运行到哪一步'), until = node('select'); until.setAttribute('aria-label', '结束阶段');
    stages.forEach(stage => {
      const a = node('option', literatureStageLabel(stage)); a.value = stage; a.disabled = !preview.allowedStages?.includes(stage); from.append(a);
      const b = node('option', literatureStageLabel(stage)); b.value = stage; until.append(b);
    });
    from.value = preview.allowedStages?.find(stage => stages.includes(stage)) || 'extract'; until.value = from.value;
    fromLabel.append(from); untilLabel.append(until); form.append(fromLabel, untilLabel);
    const fieldLabel = node('label', '初始表头'), fieldMode = node('select'); fieldMode.setAttribute('aria-label', '初始提取表头');
    [['reuse', '沿用已有字段并重新核对'], ['blank', '空白表头，先讨论填写']].forEach(([value, text]) => { const option = node('option', text); option.value = value; fieldMode.append(option); });
    fieldMode.value = 'reuse'; fieldLabel.append(fieldMode); form.append(fieldLabel);
    const scope = node('p', '', 'codex-status'), count = node('p', '', 'codex-status'), papers = node('div'); count.setAttribute('aria-live', 'polite');
    papers.style.maxHeight = '45vh'; papers.style.overflowY = 'auto';
    const errorText = node('p', '', 'codex-error'); errorText.setAttribute('role', 'alert');
    const create = node('button', '创建暂停任务并核对表头', 'primary-button'); create.type = 'submit';
    const cancel = node('button', '取消', 'quiet-button'); cancel.type = 'button'; cancel.onclick = () => dialog.close();
    const selected = new Set();
    let submitting = false, requestId = null, signature = '';
    function refresh() {
      Array.from(until.children).forEach(option => { option.disabled = stages.indexOf(option.value) < stages.indexOf(from.value); });
      if (stages.indexOf(until.value) < stages.indexOf(from.value)) until.value = from.value;
      fieldLabel.hidden = from.value !== 'extract';
      scope.textContent = from.value === 'extract' ? '已有全文将复用。创建后先核对表头，另行确认才开始执行。'
        : '只读沿用已有提取字段和前置成果，不改表头、不重做前一步；创建后另行确认范围才执行。';
      create.textContent = from.value === 'extract' ? '创建暂停任务并核对表头' : '创建暂停任务并核对范围';
      papers.replaceChildren();
      (preview.papers || []).forEach(paper => {
        const eligibility = paper.eligible?.[from.value];
        if (eligibility?.allowed !== true) selected.delete(paper.paperId);
        const wrap = node('label', paper.paperId + ' · ' + paper.title), check = node('input'); check.type = 'checkbox';
        wrap.style.display = 'block';
        check.setAttribute('aria-label', '选择文献 ' + paper.paperId);
        check.disabled = submitting || eligibility?.allowed !== true; check.checked = selected.has(paper.paperId);
        check.onchange = () => { if (check.checked) selected.add(paper.paperId); else selected.delete(paper.paperId); refresh(); };
        wrap.prepend(check); papers.append(wrap);
        if (eligibility?.allowed !== true) papers.append(node('p', '暂不可从此步开始：' + (eligibility?.reason || '前置成果尚不能复用'), 'codex-status'));
      });
      count.textContent = '已选择 ' + selected.size + ' 篇；可自由勾选，例如先选择 5 篇测试。';
      create.disabled = submitting || selected.size === 0;
      from.disabled = submitting; until.disabled = submitting; fieldMode.disabled = submitting; cancel.disabled = submitting;
    }
    from.onchange = refresh; until.onchange = refresh;
    form.append(scope, count, papers, errorText, cancel, create);
    form.onsubmit = async event => {
      event.preventDefault(); if (submitting) return;
      errorText.textContent = '';
      let selection;
      try { selection = literatureSegmentSelection(preview, from.value, until.value, [...selected]); }
      catch (error) { errorText.textContent = error.message; return; }
      const nextSignature = JSON.stringify(selection);
      if (!requestId || signature !== nextSignature) {
        requestId = root.crypto?.randomUUID?.(); signature = nextSignature;
        if (!requestId) { errorText.textContent = '无法建立任务请求标识，请在支持安全任务创建的浏览器中打开平台。'; return; }
      }
      submitting = true; refresh();
      const next = await createLiteratureSegmentTask(mod, { ...selection, preview, fieldMode: fieldMode.value, requestId });
      submitting = false;
      if (next) dialog.close(); else { errorText.textContent = task(mod.id).literatureError || '创建未完成，原任务保留。'; refresh(); }
    };
    dialog.append(form); document.body.append(dialog); literatureSegmentDialog = dialog;
    dialog.addEventListener('close', () => { if (literatureSegmentDialog === dialog) literatureSegmentDialog = null; dialog.remove(); });
    refresh(); dialog.showModal();
  }
  function literatureSegmentSummary(mod, t, job, readOnlyResults) {
    const segment = job.segmentTask;
    const box = node('section', undefined, 'literature-confirm literature-segment-summary');
    box.append(node('h4', '从已有成果开始 · ' + segment.paperIds.length + ' 篇'));
    box.append(node('p', literatureStageLabel(segment.fromStage) + ' → ' + literatureStageLabel(segment.until) + '；来源任务 ' + segment.sourceJobId.slice(0, 8) + '。原任务与已有文件保留，不重新检索或下载。', 'codex-status'));
    box.append(node('p', '本次文献：' + segment.paperIds.join('、'), 'codex-status'));
    if (segment.schemaLocked) {
      const fields = job.config?.fieldDefinitions || [];
      box.append(node('p', '字段只读沿用已有提取结果：' + (fields.map(field => field.label || field.key).join('、') || '以来源任务已确认字段为准。'), 'codex-status'));
    }
    if (job.status === 'needs_attention' && job.stage === 'awaiting_segment_confirmation') {
      box.append(node('p', '尚未运行。核对文献范围与前置成果后，点击下方按钮开始；不会重新提取或获取材料。', 'codex-status'));
      const start = node('button', '确认范围并开始执行', 'primary-button'); start.type = 'button';
      start.disabled = readOnlyResults || t.busy || t.literatureBusy || !!root.LiteratureUI?.isBusy();
      start.onclick = () => continueLiterature(mod, { until: segment.until, confirmSegment: true }); box.append(start);
    }
    return box;
  }
  async function startLiterature(mod) {
    const t = task(mod.id);
    if (t.literatureJob?.id || saved[mod.id]?.literatureJobId) {
      t.literatureError = '当前文献任务已有检索记录。正式检索或其他主题请先点“新建文献任务”；继续原结果请使用“继续下一阶段”。'; render(); return;
    }
    if (t.literaturePreparePending || saved[mod.id]?.literaturePreparePending) {
      t.literatureError = '本次规则整理尚未应用，请先重新读取结果或结束并重新整理；不会按旧草稿开始检索。'; render(); return;
    }
    if (!t.literatureConfig) { t.literatureError = '请先从对话整理运行配置并核对'; render(); return; }
    let config;
    try {
      config = effectiveLiteratureReviewConfig(t);
    } catch (error) { t.literatureError = error.message; render(); return; }
    if (config.scholarPlan?.trialMaxPages != null && (t.literatureUntil || 'discover') !== 'discover') {
      t.literatureError = '本次谷歌学术预试只检索候选，请将执行范围改为“仅检索候选”并重新核查。'; render(); return;
    }
    if (saved[mod.id]?.literatureSource !== literatureSource(mod)) { t.literatureError = '对话或已批准文档有更新，请重新整理规则后再检索'; render(); return; }
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    if (!root.LiteratureRuleReview?.matches(t.literatureRuleReview, config, t.literatureUntil || 'discover', literatureSource(mod))
      || saved[mod.id]?.literatureReviewAppliedRevision !== t.literatureRuleReview?.revision) {
      t.literatureError = '请先逐项核查当前配置，并点击“使用已确认配置”。配置变化后只需重新确认受影响的项目。';
      render(); await openLiteratureRuleReview(mod); return;
    }
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
    const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId
      && (!manager || manager.active()?.id === workspaceId);
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const sessionId = await session(mod.id);
      if (!current()) return;
      await checkLiteratureRuntime(config.sources || []);
      if (!current()) return;
      const body = { config, until: t.literatureUntil || 'discover', sessionId, workspaceId,
        reviewId: t.literatureRuleReview.id, reviewRevision: t.literatureRuleReview.revision };
      const job = await request('/api/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!current()) return;
      t.literatureJob = job;
      t.literatureConfig = JSON.parse(JSON.stringify(job.config || config));
      saved[mod.id] = { ...saved[mod.id], literatureJobId: job.id, literatureConfig: t.literatureConfig };
      persist();
      if (typeof literatureWorkspaceManager === 'function') literatureWorkspaceManager(mod)?.saveActive();
      await watchLiterature(mod.id, job.id);
    } catch (error) { if (current()) t.literatureError = error.message; }
    finally { t.literatureBusy = false; if (current()) render(); }
  }
  async function continueLiterature(mod, options = {}) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可继续的检索任务'; render(); return; }
    if (saved[mod.id]?.literatureReadOnlyJobId === job.id) { t.literatureError = '当前只读查看原结果；请返回材料补齐任务继续。'; render(); return; }
    const segment = job.segmentTask;
    if (segment && (!['extract', 'validate', 'export'].includes(segment.fromStage) || !['extract', 'validate', 'export'].includes(segment.until)
      || LITERATURE_STAGE_ORDER.indexOf(segment.until) < LITERATURE_STAGE_ORDER.indexOf(segment.fromStage))) {
      t.literatureError = '分段任务范围无效，请从历史记录重新载入。'; render(); return;
    }
    const awaitingSegment = !!segment && ((job.status === 'needs_attention' && job.stage === 'awaiting_segment_confirmation')
      || (job.status === 'cancelled' && segment.schemaLocked === true));
    if (options.confirmSegment === true && (!awaitingSegment || segment.schemaLocked !== true)) {
      t.literatureError = '当前任务不在执行范围确认关口。'; render(); return;
    }
    if (awaitingSegment && options.confirmSegment !== true) {
      t.literatureError = '请先核对所选文献和执行范围，再点击“确认范围并开始执行”。'; render(); return;
    }
    if (segment && job.status === 'needs_attention' && job.stage === 'awaiting_confirmation') {
      t.literatureError = '请先在提取字段表中核对表头、含义、单位和关联条件，再确认开始执行。'; render(); return;
    }
    if (segment?.fromStage === 'extract' && job.status === 'cancelled' && segment.fieldsConfirmed !== true) {
      t.literatureError = '本次表头尚未确认，请先点击“核对表头后继续”，核对后再开始执行。'; render(); return;
    }
    if (segment && options.until && options.until !== segment.until) {
      t.literatureError = '本次任务的开始与结束阶段已固定；其他范围请另建独立任务。'; render(); return;
    }
    const retrySkipped = options.retrySkipped === true;
    const hasSkippedMaterials = Array.isArray(job.materialSkippedActions) && job.materialSkippedActions.some(item => item.status === 'skipped' && item.paperId && item.reason);
    if (retrySkipped && (!job.materialReplenishment?.parentJobId || !hasSkippedMaterials || job.status === 'running' || job.deletedAt)) {
      t.literatureError = '当前没有可重新核查的已跳过材料，或任务仍在运行；请刷新任务状态后再试。'; render(); return;
    }
    const completedSkippedRetry = retrySkipped && job.status === 'completed' && hasSkippedMaterials;
    if ((options.deferAccess === true || options.retryDeferred === true || retrySkipped) && (!job.materialReplenishment?.parentJobId || (job.resumeStage !== 'fulltext' && !completedSkippedRetry))) {
      t.literatureError = '仅材料补齐任务可保留问题页或重新检查待处理文献。'; render(); return;
    }
    if (job.attention?.reason === 'deferred_materials' && options.retryDeferred !== true && !retrySkipped) {
      t.literatureError = '其他文献已处理；请完成登录、手动验证或权限确认，或确认保留的页面已经就绪，再点击“我已处理，重新检查待处理文献”。人工等待不限时。'; render(); return;
    }
    const deferSource = options.deferSource;
    const restoreFrozenOrder = deferSource !== undefined && t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig)
      && sameLiteratureDeferralConfig(job.config, t.literatureConfig);
    const restoreStopped = options.resumeStopped === true && options.skipUnavailable === true
      && job.status === 'cancelled' && job.resumeStage === 'fulltext';
    if (t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig) && !restoreFrozenOrder && !restoreStopped) {
      t.literatureError = '本次设置已改变，不能混入旧任务结果；请确认新配置并发起新检索，或从历史任务重新载入原配置'; render(); return;
    }
    if (deferSource !== undefined && (job.status !== 'needs_attention' || job.resumeStage !== 'discover'
      || deferSource !== job.attention?.source || !LITERATURE_EXECUTABLE_SOURCES.includes(deferSource) || !job.config?.sources?.includes(deferSource))) {
      t.literatureError = '只能暂缓当前等待人工处理的检索来源；请刷新任务状态后重试。'; render(); return;
    }
    const until = segment ? segment.until : job.materialReplenishment?.parentJobId ? 'fulltext'
      : options.until || (deferSource !== undefined ? job.until || t.literatureUntil || 'discover' : t.literatureUntil || job.until || 'discover');
    const effectiveResumeStage = completedSkippedRetry ? 'fulltext' : literatureResumeStage(job);
    if (job.materialReplenishment?.parentJobId && !effectiveResumeStage) {
      t.literatureError = '本次材料补齐已完成；原提取和导出结果保留，可点击查看。'; render(); return;
    }
    if (effectiveResumeStage && LITERATURE_STAGE_ORDER.indexOf(until) < LITERATURE_STAGE_ORDER.indexOf(effectiveResumeStage)) {
      t.literatureError = '请先在“本次做到哪一步”选择“' + literatureStageLabel(effectiveResumeStage) + '”或更后的阶段，再继续原任务'; render(); return;
    }
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      const body = { id: job.id, until, ...(deferSource !== undefined ? { deferSource } : {}),
        ...(options.skipUnavailable !== undefined ? { skipUnavailable: options.skipUnavailable } : {}),
        ...(options.deferAccess === true || options.retryDeferred === true || retrySkipped ? { deferAccess: true } : {}),
        ...(options.retryDeferred === true ? { retryDeferred: true } : {}),
        ...(retrySkipped ? { retrySkipped: true } : {}),
        ...(options.resumeConfirmed === true ? { resumeConfirmed: true } : {}),
        ...(options.confirmSegment === true ? { confirmSegment: true } : {}) };
      const next = await request('/api/literature/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (restoreFrozenOrder || restoreStopped) {
        t.literatureConfig = JSON.parse(JSON.stringify(job.config));
        saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig }; persist();
        if (restoreStopped) {
          t.literatureUntil = 'fulltext';
          saved[mod.id] = { ...saved[mod.id], literatureUntil: 'fulltext' }; persist();
        }
      }
      applyLiteratureJob(mod, next);
      await watchLiterature(mod.id, next.id || job.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  function literatureResumeStage(job) {
    if (!job) return null;
    if (job.materialReplenishment?.parentJobId) return job.status === 'completed' ? null : 'fulltext';
    const stages = job.stages || {};
    if (job.status === 'completed' && ['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'].every(stage => stages[stage] === 'done')) return null;
    if (['discover', 'dedupe', 'fulltext', 'extract', 'validate', 'export'].includes(job.resumeStage)) return job.resumeStage;
    if (job.resumeStage || job.status !== 'completed') return null;
    // Infer only an old candidate-only snapshot. A finished downstream run
    // cannot be silently turned back into full-text acquisition.
    const files = Array.isArray(job.files) ? job.files : [];
    if (['fulltext', 'extract', 'validate', 'export'].some(stage => stages[stage] === 'done')
      || files.some(name => /^(?:fulltext|extraction|validation|export)\//.test(name))) return null;
    if (!files.includes('candidates.json') && !files.includes('candidates.csv')) return null;
    return files.includes('dedupe/dedupe.json') || stages.dedupe === 'done' ? 'fulltext' : 'dedupe';
  }
  async function replenishLiteratureMaterials(mod) {
    const t = task(mod.id), original = t.literatureJob;
    if (t.busy || t.literatureBusy || root.LiteratureUI?.isBusy() || !original?.id || original.canReplenishMaterials !== true) return;
    const parentDraft = JSON.parse(JSON.stringify({ id: original.id, config: t.literatureConfig, until: t.literatureUntil,
      configOpen: t.literatureConfigOpen, source: saved[mod.id]?.literatureSource }));
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(original.config?.sources || []);
      const next = await request('/api/literature/replenish-materials', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: original.id }) });
      if (!next?.id || next.id === original.id || next.materialReplenishment?.parentJobId !== original.id || next.until !== 'fulltext') {
        throw new Error('未收到可核对的独立材料补齐任务；原候选、提取和导出结果保留，请刷新历史查看。');
      }
      t.literatureConfig = JSON.parse(JSON.stringify(next.config || original.config)); t.literatureUntil = 'fulltext';
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureUntil: 'fulltext',
        literatureMaterialsParentId: original.id, literatureMaterialsChildId: next.id, literatureMaterialsParentDraft: parentDraft,
        literatureReadOnlyJobId: null, literatureSource: literatureSource(mod) };
      applyLiteratureJob(mod, next);
      if (typeof literatureWorkspaceManager === 'function') literatureWorkspaceManager(mod)?.saveActive();
      await watchLiterature(mod.id, next.id);
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function viewLiteratureMaterialsRelatedJob(mod, targetId) {
    const t = task(mod.id), job = t.literatureJob;
    const parentId = job?.materialReplenishment?.parentJobId || saved[mod.id]?.literatureMaterialsParentId;
    const childId = saved[mod.id]?.literatureMaterialsChildId;
    if (!targetId || ![parentId, childId].includes(targetId) || t.busy || t.literatureBusy || job?.status === 'running' || root.LiteratureUI?.isBusy()) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const next = await request('/api/literature/job?id=' + encodeURIComponent(targetId));
      if (next?.id !== targetId || next.deletedAt) throw new Error('关联任务不可读取，请从历史记录核对；原材料和结果保留。');
      const draft = next.id === parentId && saved[mod.id]?.literatureMaterialsParentDraft?.id === parentId ? saved[mod.id].literatureMaterialsParentDraft : null;
      t.literatureConfig = JSON.parse(JSON.stringify(draft ? draft.config : next.config || {}));
      t.literatureUntil = draft?.until || (next.materialReplenishment?.parentJobId ? 'fulltext' : next.until || 'discover');
      if (draft) t.literatureConfigOpen = draft.configOpen;
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureUntil: t.literatureUntil,
        literatureMaterialsParentId: parentId, literatureMaterialsChildId: childId || job?.id,
        literatureReadOnlyJobId: next.id === parentId ? next.id : null,
        literatureDelivered: [next.id, next.status, next.stage || '', next.events?.length || 0].join(':'),
        literatureSource: draft ? draft.source : literatureSource(mod), literatureConfigOpen: t.literatureConfigOpen };
      applyLiteratureJob(mod, next);
      if (typeof literatureWorkspaceManager === 'function') literatureWorkspaceManager(mod)?.saveActive();
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
    if (restart === true && job.cnkiRetryItems.some(item => item.id === paperId && item.materials_only)) {
      t.literatureError = '本篇正文已保存，请使用“继续这篇材料”，无需重新定位正文。'; render(); return;
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
    if (job.stage === 'prepared' && job.status === 'needs_attention') return '已载入已确认方案，尚未执行检索。选好“本次做到哪一步”后点击“开始检索”，或导入该式导出的完整题录；遇到登录或验证时再按提示处理。';
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
  async function openLiteratureMaterialActionPage(mod, paperId) {
    const t = task(mod.id), job = t.literatureJob;
    if (!job?.materialReplenishment?.parentJobId || !Array.isArray(job.materialManualActions)
      || !job.materialManualActions.some(item => item.paperId === paperId && item.status !== 'skipped' && ['login', 'verification', 'access_required', 'page_not_ready'].includes(item.reason))
      || t.busy || t.literatureBusy || job.status === 'running' || root.LiteratureUI?.isBusy()) return;
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      await checkLiteratureRuntime(job.config?.sources || []);
      await request('/api/literature/material-action-page', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, paperId }) });
      const reason = job.materialManualActions.find(item => item.paperId === paperId)?.reason;
      const pendingPage = reason === 'page_not_ready';
      t.literatureMaterialNotice = pendingPage
        ? '已请求显示保留的原页面。页面尚未就绪，保留后稍后检查；确认页面加载或文件生成完成后，再点击“我已处理，重新检查待处理文献”。'
        : reason === 'verification'
        ? '已请求显示本篇保留的验证页。请手动完成验证码；窗口保留，人工验证不限时。完成后回平台点击“我已处理，重新检查待处理文献”。'
        : '已请求显示本篇原官方问题页。人工登录不限时，窗口保留；处理后回平台点击“我已处理，重新检查待处理文献”。';
    } catch (error) { t.literatureError = error.message; }
    finally { t.literatureBusy = false; render(); }
  }
  async function confirmLiteratureFields(mod) {
    const t = task(mod.id);
    if (root.LiteratureUI?.isBusy() || t.busy || t.literatureBusy || t.literatureFieldsAssistBusy) return;
    const job = t.literatureJob;
    if (!job?.id) { t.literatureError = '没有可确认的检索任务'; render(); return; }
    if (job.materialReplenishment?.parentJobId || saved[mod.id]?.literatureReadOnlyJobId === job.id) {
      t.literatureError = '当前仅补齐材料或只读查看原结果，不执行参数提取。'; render(); return;
    }
    if (job.segmentTask && (job.segmentTask.schemaLocked || job.segmentTask.fromStage !== 'extract')) {
      t.literatureError = '本次沿用已有提取字段，只确认执行范围，不修改表头或重做提取。'; render(); return;
    }
    if (literatureFieldsAssistState(mod, job).pending) return;
    const stoppedFieldGate = job.status === 'cancelled' && job.segmentTask?.fromStage === 'extract' && job.segmentTask.fieldsConfirmed !== true;
    if (!stoppedFieldGate && (job.status !== 'needs_attention' || job.stage !== 'awaiting_confirmation')) {
      t.literatureFieldsError = '当前可先保存字段草稿；运行到提取阶段后再确认。'; renderLiteratureFieldsDialog(); return;
    }
    if (t.literatureConfig && !sameLiteratureConfig(job.config, t.literatureConfig)) {
      t.literatureFieldsError = '检索设置已改变，请从历史任务重新载入原配置后再确认提取字段；字段草稿会保留。'; renderLiteratureFieldsDialog(); return;
    }
    // The field gate uses the segment's frozen range, or extraction only for
    // an ordinary task. The outer search-stage selector cannot broaden it.
    const until = job.segmentTask ? job.segmentTask.until : 'extract';
    if (!['extract', 'validate', 'export'].includes(until)) {
      t.literatureFieldsError = '当前分段任务的结束阶段无效，请重新载入任务。'; renderLiteratureFieldsDialog(); return;
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
      t.literatureUntil = until;
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
  function attachLiteratureHistoryContext(mod, job) {
    try {
      if (!job?.id || job.deletedAt) throw new Error('该历史任务不可载入；已删除任务请先恢复。');
      if (literatureWorkspaceBusy(mod.id)) throw new Error('当前有对话、文献运行或任务切换正在处理；可以只读查看，处理结束后再载入。');
      const manager = literatureWorkspaceManager(mod);
      const origin = manager?.active?.(), originProjectId = root.TaskManager?.currentTaskId?.();
      if (manager) {
        const ready = manager.saveActive(); if (!ready.ok) throw new Error(ready.error);
        const known = manager.list().find(context => context.jobId === job.id);
        const result = known ? manager.switch(known.id) : manager.create({ name: String(job.config?.topic || '历史文献任务 ' + job.id.slice(0, 8)).slice(0, 80),
          mode: job.config?.searchMode === 'formal' ? 'formal' : 'test',
          seedClient: { backend: task(mod.id).backend, model: task(mod.id).model,
            literatureConfig: JSON.parse(JSON.stringify(job.config || {})), literatureUntil: job.until || 'discover', literatureConfigOpen: false } });
        if (!result.ok) throw new Error(result.error);
      }
      // Existing workspaces can contain a newer scientific draft. Loading a
      // saved run updates its metadata without replacing that draft or chat.
      commitLiteratureRevision(mod, { ...saved[mod.id], literatureJobId: job.id, literatureHistoryLoadedJobId: job.id,
        ...(origin && manager.active()?.id !== origin.id ? { literatureDiscussionOrigin: { projectId: originProjectId, workspaceId: origin.id, name: origin.name } } : {}) }, { literatureJob: job, literatureError: '' }, manager);
      ModuleSpace.render(); return { ok: true };
    } catch (error) {
      task(mod.id).literatureError = '载入历史任务失败：' + error.message; render();
      return { ok: false, error: task(mod.id).literatureError };
    }
  }
  function closeLiteratureHistoryDetails() {
    const state = literatureHistoryDetailsDialog; if (!state) return;
    literatureHistoryDetailsDialog = null; state.element.close(); state.element.remove();
  }
  function continueLiteratureHistoryDiscussion(state) {
    if (!literatureHistoryDetailsCurrent(state)) { state.notice = '工作区已切换，请重新打开历史任务。'; renderLiteratureHistoryDetails(state); return; }
    const job = state.job;
    if (!job?.id || job.deletedAt || job.status === 'running' || job.segmentTask || job.materialReplenishment?.parentJobId || literatureWorkspaceBusy(state.mod.id)) {
      state.notice = '这次任务当前不能进入讨论修改；请等待运行或其他操作结束。'; renderLiteratureHistoryDetails(state); return;
    }
    try {
      const previous = saved[state.mod.id] || {};
      const alreadyHere = previous.literatureJobId === job.id || previous.literatureRevisionParentId === job.id
        || previous.literatureRevisionOriginal?.job?.id === job.id || previous.literatureDiscussionEditingForJobId === job.id;
      if (!alreadyHere) {
        const attached = attachLiteratureHistoryContext(state.mod, job);
        if (!attached?.ok) throw new Error(attached?.error || '未能保留当前草稿，未进入修改讨论。');
      }
      const fresh = Store.getState().modules.find(item => item.id === state.mod.id);
      if (!fresh) throw new Error('文献模块已变化，原讨论未改动。');
      const next = { ...saved[fresh.id], literatureDiscussionEditingForJobId: job.id };
      commitLiteratureRevision(fresh, next, { literatureError: '' }, literatureWorkspaceManager(fresh));
      closeLiteratureHistoryDetails(); render(); ModuleSpace.render();
      if (!(fresh.messages || []).some(message => message.role === 'user') && root.LiteratureDiscussions?.open) {
        void root.LiteratureDiscussions.open(fresh.id); return;
      }
      const input = document.getElementById?.('composer-input'); input?.focus?.();
    } catch (error) { state.task = task(state.mod.id); state.notice = '未能继续讨论：' + error.message; renderLiteratureHistoryDetails(state); }
  }
  function literatureHistoryDetailsCurrent(state) {
    return literatureHistoryDetailsDialog === state && task(state.mod.id) === state.task
      && (root.TaskManager?.currentTaskId?.() || '') === state.projectId && Store.getState().activeModuleId === state.mod.id;
  }
  function renderLiteratureHistoryDetails(state) {
    if (literatureHistoryDetailsDialog !== state) return;
    const content = state.content; content.replaceChildren();
    if (state.loading) { content.append(node('p', '正在读取这次任务的最新存档…', 'codex-status')); return; }
    if (state.error) content.append(node('p', '历史详情读取失败：' + state.error + ' 当前任务、讨论和草稿未因查看而改动。', 'codex-error'));
    const job = state.job;
    if (job) {
      content.append(node('h3', job.config?.topic || '未登记研究主题'));
      const meta = node('dl', undefined, 'literature-history-details-meta');
      const time = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN') : '未记录';
      [['任务编号', job.id], ['状态', LITERATURE_STATUS_LABELS[job.status] || job.status || '未知'], ['创建时间', time(job.createdAt)],
        ['更新时间', time(job.updatedAt)], ['执行到', literatureStageLabel(job.until || 'discover')],
        ['当前阶段', literatureStageLabel(job.stage || 'queued')], ['候选条数', Number.isFinite(job.count) ? String(job.count) : '尚未记录']]
        .forEach(([label, value]) => meta.append(node('dt', label), node('dd', value)));
      content.append(meta, node('p', literatureStatusText(job), 'codex-status'));
      if (job.message) content.append(node('p', '运行消息：' + job.message));
      if (job.error) content.append(node('p', '运行问题：' + job.error, 'codex-error'));
      if (job.status === 'running') content.append(node('p', '这次任务仍在运行。这里只读取已有进度；点击“刷新详情”读取最新记录，不会继续或重新运行。', 'codex-status'));
      const files = literatureDeliverables(job);
      content.append(node('h3', '已保存文件'));
      if (files) {
        // History must show its actual files immediately, even for a stopped
        // run. The ordinary workbench keeps its compact disclosures separately.
        Array.from(files.children).filter(child => child.tagName === 'DETAILS').forEach(child => { child.open = true; });
        content.append(files);
      } else content.append(node('p', job.status === 'running' ? '此轮尚未产生结果文件；任务运行中，可以稍后刷新。' : '此轮尚未产生结果文件。不能据此认定已完成数据提取。', 'codex-status'));
      const frozen = node('button', '查看启动时的已确认配置', 'quiet-button'); frozen.type = 'button';
      frozen.disabled = !root.LiteratureRuleReview?.openFrozenJob;
      frozen.onclick = () => {
        if (!literatureHistoryDetailsCurrent(state)) { state.notice = '工作区已切换，请关闭后重新查看该任务。'; renderLiteratureHistoryDetails(state); return; }
        void root.LiteratureRuleReview.openFrozenJob(job.id, { title: job.config?.topic, sourceLabels: LITERATURE_SOURCE_LABELS, request,
          isCurrent: () => literatureHistoryDetailsCurrent(state) });
      };
      content.append(frozen, node('p', '启动时的配置与核查记录只读；旧任务未保存核查快照时会明确提示。查看不会把它覆盖到当前草稿。', 'codex-status'));
      const queries = node('details', undefined, 'literature-history-details-queries'); queries.append(node('summary', '本次存档的检索式'));
      const sourceQueries = job.config?.sourceQueries;
      if (job.config?.query) queries.append(node('p', '通用检索式'), node('pre', job.config.query));
      if (sourceQueries && typeof sourceQueries === 'object') Object.entries(sourceQueries).forEach(([source, query]) => {
        queries.append(node('p', LITERATURE_SOURCE_LABELS[source] || source), node('pre', typeof query === 'string' ? query : JSON.stringify(query, null, 2)));
      });
      if (!job.config?.query && !Object.keys(sourceQueries || {}).length) queries.append(node('p', '这次存档未记录检索式。', 'codex-status'));
      content.append(queries);
      if (Array.isArray(job.events) && job.events.length) {
        const events = node('details'); events.append(node('summary', '阶段记录 · ' + job.events.length + ' 条'));
        job.events.forEach(event => events.append(node('p', [time(event.at), literatureStageLabel(event.stage || ''), event.message || ''].filter(Boolean).join(' · '))));
        content.append(events);
      }
    }
    if (state.notice) content.append(node('p', state.notice, 'codex-status'));
    const actions = node('div', undefined, 'literature-history-details-actions');
    const refresh = node('button', '刷新详情', 'quiet-button'); refresh.type = 'button'; refresh.onclick = () => loadLiteratureHistoryDetails(state); actions.append(refresh);
    if (job) {
      const busy = literatureWorkspaceBusy(state.mod.id), current = literatureHistoryDetailsCurrent(state);
      if (!job.segmentTask && !job.materialReplenishment?.parentJobId) {
        const discuss = node('button', '继续讨论并更新规则', 'primary-button'); discuss.type = 'button';
        discuss.disabled = busy || !current || job.status === 'running' || !!job.deletedAt || !!state.error;
        discuss.title = '进入讨论修改草稿，保留已有新规则；从对话更新成功后再逐项核查，不启动或继续检索。';
        discuss.onclick = () => continueLiteratureHistoryDiscussion(state); actions.append(discuss);
      }
      const load = node('button', '载入此任务到工作区', 'quiet-button'); load.type = 'button'; load.disabled = busy || !current || !!job.deletedAt || !!state.error;
      const reason = !current ? '工作区已切换，请关闭后重新查看。' : busy ? '当前有任务或对话正在处理；可以只读查看，处理结束后刷新详情再载入。'
        : job.deletedAt ? '此任务已删除，请先在历史列表恢复。' : '载入会切换到对应文献工作区；该工作区已有的讨论和规则草稿保留，不会重新运行任务。';
      load.title = reason; actions.append(load); content.append(node('p', reason, 'codex-status'));
      load.onclick = () => {
        if (!literatureHistoryDetailsCurrent(state)) { state.notice = '工作区已切换，未载入历史任务。'; renderLiteratureHistoryDetails(state); return; }
        if (literatureWorkspaceBusy(state.mod.id)) { state.notice = '当前仍在处理其他操作，未载入。可以继续只读查看，处理结束后再试。'; renderLiteratureHistoryDetails(state); return; }
        const result = attachLiteratureHistoryContext(state.mod, job);
        state.task = task(state.mod.id);
        state.loaded = result?.ok === true;
        state.notice = result?.ok ? '已载入这次任务。该工作区原有讨论和规则草稿保留；关闭详情后可在工作区继续查看。' : result?.error || '未能载入该任务，原草稿保留。';
        renderLiteratureHistoryDetails(state); state.heading.focus?.();
      };
      if (state.loaded && !job.segmentTask && !job.materialReplenishment?.parentJobId) {
        const revised = node('button', task(state.mod.id).literatureReviewNeedsSync || !sameLiteratureConfig(job.config, task(state.mod.id).literatureConfig)
          ? '继续逐项核查当前草稿' : '从历史配置建立修改草稿', 'primary-button'); revised.type = 'button';
        revised.disabled = busy || !current || job.status === 'running' || !!job.deletedAt;
        revised.title = '显式导入历史依据，再同步当前讨论和最新草稿；旧结果保留，核查后才会按新配置开始。';
        revised.onclick = () => {
          if (!literatureHistoryDetailsCurrent(state)) { state.notice = '工作区已切换，未建立修改草稿。'; renderLiteratureHistoryDetails(state); return; }
          closeLiteratureHistoryDetails(); return reviseLiteratureConfiguration(state.mod, { fromHistory: true });
        }; actions.append(revised);
      }
    }
    content.append(actions);
  }
  async function loadLiteratureHistoryDetails(state) {
    if (!literatureHistoryDetailsCurrent(state)) { state.notice = '工作区已切换，请关闭后重新查看。'; renderLiteratureHistoryDetails(state); return; }
    state.loading = true; state.error = ''; renderLiteratureHistoryDetails(state);
    try {
      const job = await request('/api/literature/job?id=' + encodeURIComponent(state.jobId));
      if (!literatureHistoryDetailsCurrent(state)) return;
      if (job?.id !== state.jobId) throw new Error('返回的任务编号不匹配，未载入任何任务。');
      state.job = job;
    } catch (error) { if (!literatureHistoryDetailsCurrent(state)) return; state.error = error.message; }
    finally {
      if (literatureHistoryDetailsDialog === state) { state.loading = false; if (!literatureHistoryDetailsCurrent(state)) state.notice = '工作区已切换，请关闭后重新查看。'; renderLiteratureHistoryDetails(state); }
    }
  }
  async function openLiteratureHistoryDetails(mod, job) {
    if (!job?.id) return;
    closeLiteratureHistoryDetails();
    const dialog = node('dialog', undefined, 'literature-help-dialog literature-history-details-dialog'); dialog.setAttribute('aria-label', '历史文献任务详情');
    const head = node('div', undefined, 'literature-help-head'), heading = node('h2', '历史任务详情 · ' + job.id.slice(0, 8)); heading.tabIndex = -1;
    const close = node('button', '关闭', 'quiet-button'); close.type = 'button'; close.onclick = closeLiteratureHistoryDetails;
    head.append(heading, close); const content = node('div');
    dialog.append(head, node('p', '这里查看当时的存档和文件。要修改规则，请点下方“继续讨论并更新规则”；仅查看或关闭不会修改当前草稿。', 'codex-status'), content);
    const state = { element: dialog, heading, content, mod, task: task(mod.id), projectId: root.TaskManager?.currentTaskId?.() || '', jobId: job.id, job: null, notice: '' };
    literatureHistoryDetailsDialog = state;
    dialog.onclose = () => { if (literatureHistoryDetailsDialog === state) literatureHistoryDetailsDialog = null; dialog.remove(); };
    document.body.append(dialog); dialog.showModal(); await loadLiteratureHistoryDetails(state);
  }
  function literatureSource(mod) {
    const entries = (mod.messages || []).filter(message => message.role === 'user' || message.role === 'assistant');
    return JSON.stringify({ messages: entries.map(message => [message.id, message.at]),
      approvedDoc: mod.doc?.status === 'approved' ? [mod.doc.content, mod.doc.approvedAt] : null });
  }
  function effectiveLiteratureReviewConfig(t) {
    // Once reviewed, the saved values are the execution basis. Do not silently
    // reorder sources or replace reviewed stop/model settings at launch time.
    const config = JSON.parse(JSON.stringify(t.literatureConfig));
    normalizeLiteratureDraftRules(config, message => { t.literatureConfigNotice = message; });
    if (!config.searchMode) Object.assign(config, newLiteratureSearchConfig(config));
    config.extraction = { ...config.extraction, model: config.extraction?.model || t.model || account?.model || null };
    return config;
  }
  function commitLiteratureRevision(mod, nextClient, updates, manager = literatureWorkspaceManager(mod)) {
    const t = task(mod.id), previousSaved = saved, previousRaw = localStorage.getItem(key);
    const previous = Object.fromEntries(Object.keys(updates).map(name => [name, t[name]]));
    let written = false;
    try {
      const nextSaved = { ...saved, [mod.id]: nextClient };
      // Unlike the general autosave helper, a revision transition must fail
      // visibly before detaching the original job if storage is unavailable.
      localStorage.setItem(key, JSON.stringify(nextSaved)); written = true;
      saved = nextSaved; Object.assign(t, updates);
      const stored = manager?.saveActive(); if (stored?.ok === false) throw new Error(stored.error || '文献任务快照未能保存');
      root.LiteratureDiscussions?.schedule?.(mod.id);
    } catch (error) {
      saved = previousSaved; Object.assign(t, previous);
      let restoration = '';
      if (written) try { if (previousRaw === null) localStorage.removeItem(key); else localStorage.setItem(key, previousRaw); }
      catch (_) { restoration = ' 浏览器恢复保存失败，请保留当前页面；原绑定和草稿仍在内存中。'; }
      throw new Error('切换未保存，原任务或修改草稿已保留：' + error.message + restoration);
    }
  }
  async function reviseLiteratureConfiguration(mod, options = {}) {
    const t = task(mod.id), job = t.literatureJob;
    if (!job?.id || job.segmentTask || job.materialReplenishment?.parentJobId || saved[mod.id]?.literatureReadOnlyJobId === job.id
      || job.deletedAt || job.status === 'running' || t.busy || t.literatureBusy || root.LiteratureUI?.isBusy() || root.ModuleSpace?.isBusy()) return;
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
    const sameContext = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId && (!manager || manager.active()?.id === workspaceId);
    const current = () => sameContext() && Store.getState().activeModuleId === mod.id && t.literatureJob?.id === job.id;
    const snapshot = () => {
      const fresh = Store.getState().modules?.find(item => item.id === mod.id); if (!fresh) return null;
      return { config: JSON.parse(JSON.stringify(t.literatureConfig || job.config || {})), until: t.literatureUntil || job.until || 'discover',
        source: literatureSource(fresh), context: { messages: (fresh.messages || []).filter(message => ['user', 'assistant'].includes(message.role))
          .map(message => ({ role: message.role, text: message.text })), approvedDoc: fresh.doc?.status === 'approved' ? fresh.doc.content : '' },
        reviewSignature: JSON.stringify([t.literatureRuleReview?.id, t.literatureRuleReview?.revision, saved[mod.id]?.literatureReviewAppliedRevision]) };
    };
    const basis = snapshot(), basisSignature = JSON.stringify(basis);
    if (!basis) { t.literatureError = '当前文献模块已变化，未建立修改草稿。'; render(); return; }
    const initialClient = JSON.parse(JSON.stringify(saved[mod.id] || {})), originalClient = JSON.parse(JSON.stringify(initialClient));
    delete originalClient.literatureRevisionDraft; delete originalClient.literatureRevisionOriginal;
    const backup = { client: originalClient, job: JSON.parse(JSON.stringify(job)), ...(manager?.captureCurrent ? { context: manager.captureCurrent() } : {}) };
    t.literatureBusy = true; t.literatureError = ''; render();
    try {
      const sessionId = await session(mod.id); if (!current()) return;
      if (JSON.stringify(snapshot()) !== basisSignature) throw new Error('讨论、草稿或确认版本已变化，尚未建立修改草稿；请按当前内容重试。');
      const { source, context } = basis;
      const input = { jobId: job.id, sessionId, workspaceId, source, context, ...(options.fromHistory === true ? { fromHistory: true } : {}) }, signature = JSON.stringify({ input, basisSignature });
      if (t.literatureRevisionForkAttempt?.signature !== signature) {
        const requestId = root.crypto?.randomUUID?.(); if (!requestId) throw new Error('浏览器无法建立修订请求标识，原任务保留。');
        t.literatureRevisionForkAttempt = { signature, requestId };
      }
      let review = await request('/api/literature/rule-review/fork', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, requestId: t.literatureRevisionForkAttempt.requestId }) });
      if (!current()) return;
      if (saved[mod.id]?.sessionId !== sessionId || JSON.stringify(snapshot()) !== basisSignature) throw new Error('讨论、草稿或确认版本已变化，旧响应未覆盖当前草稿；请按当前内容重试。');
      if (!review?.id || review.sessionId !== sessionId || review.workspaceId !== workspaceId || review.parentJobId !== job.id || !review.config || !Array.isArray(review.items)) throw new Error('修订草稿与当前任务不匹配，原任务保留。');
      if (JSON.stringify(review.config) !== JSON.stringify(basis.config) || review.until !== basis.until) {
        review = await request('/api/literature/rule-review/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: review.id, sessionId, revision: review.revision, action: 'sync', config: basis.config, until: basis.until, source, context }) });
        if (!current()) return;
        if (saved[mod.id]?.sessionId !== sessionId || JSON.stringify(snapshot()) !== basisSignature) throw new Error('同步期间草稿或讨论已变化，旧响应未覆盖；原任务和当前草稿保留。');
        if (!review?.id || review.sessionId !== sessionId || review.workspaceId !== workspaceId || review.parentJobId !== job.id || !review.config || !Array.isArray(review.items)) throw new Error('同步的修订草稿不属于当前文献任务，原草稿保留。');
      }
      const next = { ...saved[mod.id], literatureConfig: JSON.parse(JSON.stringify(review.config)), literatureUntil: review.until,
        literatureRuleReviewId: review.id, literatureRuleReview: review, literatureReviewNeedsSync: false, literatureSource: source,
        literatureRevisionParentId: job.id, literatureRevisionOriginal: backup, literatureConfigNotice: options.fromHistory === true
          ? '已从历史配置建立修改草稿，并保留当前讨论和最新规则；核查后才会按新配置建立新任务，旧结果保留。' : '正在修改原任务配置。确认后将建立新的检索任务，原结果保留。' };
      for (const key of ['literatureJobId', 'literatureDelivered', 'literatureAutoOpenStamp', 'literatureReadOnlyJobId', 'literatureReviewAppliedRevision', 'literatureRevisionDraft', 'literatureHistoryLoadedJobId']) delete next[key];
      commitLiteratureRevision(mod, next, { literatureWatchGeneration: (t.literatureWatchGeneration || 0) + 1,
        literatureJob: null, literatureConfig: JSON.parse(JSON.stringify(review.config)), literatureUntil: review.until,
        literatureRuleReview: review, literatureReviewNeedsSync: false, literatureConfigNotice: next.literatureConfigNotice,
        literatureJobsTried: false, literatureBusy: false, literatureRevisionNeedsHistoryImport: false }, manager);
      render(); await openLiteratureRuleReview(Store.getState().modules.find(item => item.id === mod.id) || mod);
    } catch (error) { if (sameContext()) {
      if (['REVIEW_SESSION_MISMATCH', 'REVIEW_WORKSPACE_MISMATCH'].includes(error.code)) t.literatureRevisionNeedsHistoryImport = true;
      t.literatureError = error.message; render();
    } }
    finally { if (sameContext()) { t.literatureBusy = false; render(); } }
  }
  function swapLiteratureRevision(mod, toOriginal) {
    const t = task(mod.id), client = saved[mod.id];
    if (!client || t.busy || t.literatureBusy || t.literatureJob?.status === 'running' || root.LiteratureUI?.isBusy() || root.ModuleSpace?.isBusy()) return;
    const target = toOriginal ? client.literatureRevisionOriginal : client.literatureRevisionDraft;
    if (!target?.client || !target.job && toOriginal) return;
    root.LiteratureRuleReview?.close();
    const previousJob = t.literatureJob;
    const manager = literatureWorkspaceManager(mod);
    const next = JSON.parse(JSON.stringify(target.client));
    if (toOriginal) {
      const draftClient = JSON.parse(JSON.stringify(client)); delete draftClient.literatureRevisionDraft;
      next.literatureRevisionDraft = { client: draftClient, job: previousJob ? JSON.parse(JSON.stringify(previousJob)) : null,
        ...(manager?.captureCurrent ? { context: manager.captureCurrent() } : {}) };
    }
    try {
      if (target.context && manager?.restoreCurrent) {
        const envelope = JSON.parse(JSON.stringify(target.context)); envelope.snapshot.client = next;
        const restored = manager.restoreCurrent(envelope); if (!restored.ok) throw new Error(restored.error);
        const freshTask = task(mod.id); freshTask.literatureJob = target.job ? JSON.parse(JSON.stringify(target.job)) : null;
        freshTask.literatureError = ''; ModuleSpace.render();
        root.LiteratureDiscussions?.schedule?.(mod.id);
        if (freshTask.literatureJob?.id) void hydrateLiteratureWorkspace(mod);
        render(); return;
      }
      commitLiteratureRevision(mod, next, { literatureWatchGeneration: (t.literatureWatchGeneration || 0) + 1,
        literatureJob: target.job ? JSON.parse(JSON.stringify(target.job)) : null,
        literatureConfig: JSON.parse(JSON.stringify(next.literatureConfig || target.job?.config || null)),
        literatureUntil: next.literatureUntil || target.job?.until || 'discover', literatureRuleReview: next.literatureRuleReview || null,
        literatureReviewNeedsSync: next.literatureReviewNeedsSync === true, literatureConfigNotice: next.literatureConfigNotice || '',
        literatureError: '这份旧备份未单独保存讨论快照；已保留当前讨论，没有把它当作原讨论恢复。可在“讨论记录”查找原文。', literatureJobsTried: false });
      if (t.literatureJob?.id) void hydrateLiteratureWorkspace(mod);
    } catch (error) { t.literatureError = error.message; }
    render();
  }
  async function openLiteratureRuleReview(mod, options = {}) {
    const t = task(mod.id);
    if (!root.LiteratureRuleReview) return;
    const frozenJobId = t.literatureJob?.id || saved[mod.id]?.literatureJobId;
    if (frozenJobId && options.draft !== true) {
      if (t.literatureJob?.segmentTask) return;
      const fromHistory = saved[mod.id]?.literatureHistoryLoadedJobId === frozenJobId || t.literatureRevisionNeedsHistoryImport === true
        || /原任务规则快照不属于当前文献(?:会话|任务|工作区)/.test(t.literatureError || '');
      const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
      const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId
        && (!manager || manager.active()?.id === workspaceId) && Store.getState().activeModuleId === mod.id
        && (t.literatureJob?.id || saved[mod.id]?.literatureJobId) === frozenJobId;
      await root.LiteratureRuleReview.openFrozenJob(frozenJobId, { title: t.literatureJob?.config?.topic,
        sourceLabels: LITERATURE_SOURCE_LABELS, isCurrent: current, request,
        onRevise: t.literatureJob?.id === frozenJobId && saved[mod.id]?.literatureReadOnlyJobId !== frozenJobId
          && !t.literatureJob?.materialReplenishment?.parentJobId ? () => reviseLiteratureConfiguration(mod, { fromHistory }) : null,
        reviseLabel: fromHistory ? '从历史配置建立修改草稿' : '修改配置并继续',
        canRevise: !!t.literatureJob && !t.literatureJob.deletedAt && t.literatureJob.status !== 'running' && !t.busy && !t.literatureBusy && !root.ModuleSpace?.isBusy() });
      return;
    }
    if (!t.literatureConfig || t.literatureBusy || t.busy) return;
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod);
    const workspaceId = manager?.active()?.id || mod.id;
    const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId
      && (!manager || manager.active()?.id === workspaceId) && Store.getState().activeModuleId === mod.id;
    try {
      const sid = await session(mod.id);
      if (!current()) return;
      const fresh = Store.getState().modules.find(item => item.id === mod.id); if (!fresh) return;
      const config = effectiveLiteratureReviewConfig(t), source = literatureSource(fresh);
      const independentDraft = !!frozenJobId && options.draft === true;
      const reviewId = independentDraft ? saved[mod.id]?.literatureDraftReviewForJobId === frozenJobId ? saved[mod.id]?.literatureDraftReviewId : null : saved[mod.id]?.literatureRuleReviewId;
      const draftNotice = independentDraft ? '正在核查当前规则草稿；旧任务的冻结配置只读保留。这里显示的检索式就是当前草稿实际值，不会先复制旧任务配置。' : '';
      const staleNotice = saved[mod.id]?.literatureSource !== source ? '讨论有新内容，但尚未成功整理到当前规则草稿；下面显示已有草稿，不表示新要求已经写入。请先核对实际检索式，或返回“从对话更新规则并核查”。' : '';
      t.literatureConfig = JSON.parse(JSON.stringify(config));
      saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureConfigNotice: t.literatureConfigNotice }; persist();
      await root.LiteratureRuleReview.open({ sessionId: sid, workspaceId, config, until: t.literatureUntil || 'discover', source,
        reviewId, model: t.model || account?.model,
        context: { messages: (fresh.messages || []).filter(message => message.role === 'user' || message.role === 'assistant')
          .map(message => ({ role: message.role, text: message.text })), approvedDoc: fresh.doc?.status === 'approved' ? fresh.doc.content : '' },
        sourceLabels: LITERATURE_SOURCE_LABELS, request, isCurrent: current,
        formatNotice: [draftNotice, staleNotice, t.literatureConfigNotice || ''].filter(Boolean).join('\n'),
        revisionParentId: saved[mod.id]?.literatureRevisionParentId || '',
        onSave: review => {
          if (!current()) return;
          t.literatureRuleReview = review; t.literatureConfig = JSON.parse(JSON.stringify(review.config)); t.literatureUntil = review.until; t.literatureReviewNeedsSync = false;
          saved[mod.id] = { ...saved[mod.id], literatureRuleReviewId: review.id, literatureRuleReview: review,
            literatureConfig: t.literatureConfig, literatureUntil: review.until, literatureReviewNeedsSync: false,
            ...(independentDraft ? { literatureDraftReviewForJobId: frozenJobId, literatureDraftReviewId: review.id } : {}) };
          persist(); manager?.saveActive(); render();
        },
        onApply: review => {
          if (!current()) return;
          if (independentDraft) {
            const originalClient = JSON.parse(JSON.stringify(saved[mod.id] || {})); delete originalClient.literatureRevisionOriginal; delete originalClient.literatureRevisionDraft;
            const original = { client: originalClient, job: JSON.parse(JSON.stringify(t.literatureJob || { id: frozenJobId })), ...(manager?.captureCurrent ? { context: manager.captureCurrent() } : {}) };
            const next = { ...saved[mod.id], literatureConfig: JSON.parse(JSON.stringify(review.config)), literatureUntil: review.until, literatureSource: source,
              literatureRuleReviewId: review.id, literatureRuleReview: review, literatureReviewAppliedRevision: review.revision,
              literatureRevisionParentId: frozenJobId, literatureRevisionOriginal: original, literatureReviewNeedsSync: false };
            for (const name of ['literatureJobId', 'literatureDelivered', 'literatureAutoOpenStamp', 'literatureReadOnlyJobId']) delete next[name];
            commitLiteratureRevision(mod, next, { literatureJob: null, literatureConfig: next.literatureConfig, literatureUntil: review.until,
              literatureRuleReview: review, literatureReviewNeedsSync: false, literatureError: '', literatureBusy: false }, manager);
            render(); return;
          }
          t.literatureConfig = JSON.parse(JSON.stringify(review.config)); t.literatureUntil = review.until; t.literatureError = '';
          saved[mod.id] = { ...saved[mod.id], literatureConfig: t.literatureConfig, literatureUntil: review.until,
            literatureSource: source, literatureRuleReviewId: review.id, literatureRuleReview: review, literatureReviewAppliedRevision: review.revision,
            ...(independentDraft ? { literatureDraftReviewForJobId: frozenJobId, literatureDraftReviewId: review.id } : {}) };
          persist(); manager?.saveActive(); render();
        }, onConfigError: () => {
          if (!current()) return;
          t.literatureConfigOpen = true;
          saved[mod.id] = { ...saved[mod.id], literatureConfigOpen: true }; persist(); render();
          const settings = panel.querySelector('.literature-config');
          if (settings) { settings.open = true; settings.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }
        }, onClose: () => { if (current()) render(); }
      });
    } catch (error) { if (current()) { t.literatureError = error.message; render(); } }
  }
  const LITERATURE_CONFIG_KEYS = ['topic', 'query', 'sources', 'publicationYearFrom', 'publicationYearTo', 'geography', 'language',
    'studyTypes', 'inclusion', 'exclusion', 'targetFields', 'limit', 'sourceQueries', 'searchMode', 'perSourceLimit', 'stopMode', 'scholarPlan', 'screeningPolicy', 'researchPlan'];
  const LITERATURE_CONFIG_EXTRA_KEYS = ['batch', 'fieldDefinitions', 'templates', 'fulltext', 'extraction', 'limits'];
  function literatureDraftRuleList(value) {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const entries = Array.isArray(value) ? value : [value];
    return entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry));
  }
  function normalizeLiteratureDraftRules(config, onFormatNotice) {
    const names = { studyTypes: '研究类型', inclusion: '纳入规则', exclusion: '排除规则', targetFields: '目标字段' }, converted = [];
    Object.keys(names).forEach(key => {
      const value = config[key];
      if (value != null && (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))) converted.push(names[key]);
      config[key] = literatureDraftRuleList(value);
    });
    if (converted.length) onFormatNotice?.('格式兼容提示：' + converted.join('、') + '已整理为待核查列表。文字只按完整行分项，结构化内容以完整 JSON 文本保留；未删减规则，尚未自动确认。');
    return config;
  }
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
  function parseLiteratureConfig(text, options = {}) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 未返回运行配置；请重试或手动填写');
    let config = JSON.parse(raw.slice(start, end + 1));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AI 返回的配置格式无效');
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key), copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const notices = [], baseline = options.baseline && typeof options.baseline === 'object' && !Array.isArray(options.baseline) ? options.baseline : {};
    if (own(config, 'config')) {
      if (Object.keys(config).length !== 1 || !config.config || typeof config.config !== 'object' || Array.isArray(config.config)) throw new Error('AI 配置包装格式无效；仅支持单独的 {"config":{...}}，原草稿保留');
      config = config.config; notices.push('已读取明确的 config 对象；内容仍为待核查草稿。');
    }
    const allowed = [...LITERATURE_CONFIG_KEYS, ...LITERATURE_CONFIG_EXTRA_KEYS, 'version'];
    const returned = Object.keys(config), unknown = returned.filter(key => !allowed.includes(key));
    if (!returned.length || unknown.length) throw new Error(unknown.length ? 'AI 返回了不支持的配置字段：' + unknown.join('、') + '；未把说明文字当作配置更新，原草稿保留' : 'AI 返回了空配置，未更新任何规则；原草稿保留');
    if (own(config, 'searchMode') && !['test', 'formal'].includes(config.searchMode)) throw new Error('请选择测试运行或正式检索；原草稿保留');
    const inherited = [], take = (key, fallback) => {
      if (own(config, key)) return copy(config[key]);
      if (own(baseline, key)) { inherited.push(key); return copy(baseline[key]); }
      return fallback;
    };
    const sources = take('sources', null), knownSources = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed', 'pmc', 'openalex', 'europe-pmc', 'semantic-scholar'];
    if (!Array.isArray(sources)) throw new Error(own(config, 'sources') ? 'AI 返回的检索来源必须是列表；原草稿保留' : 'AI 未明确返回检索来源，当前也无有效来源基线；请重新整理规则');
    if (!sources.length || sources.some(value => typeof value !== 'string' || !knownSources.includes(value)) || new Set(sources).size !== sources.length) throw new Error('检索来源为空、重复或不受识别；未静默沿用或删除来源，原草稿保留');
    const parsed = { sources };
    for (const key of ['topic', 'query', 'geography', 'language']) {
      const value = take(key, ''); if (typeof value !== 'string') throw new Error((key === 'query' ? '默认检索式' : key) + '必须是文本；原草稿保留'); parsed[key] = value;
    }
    if (parsed.query.length > 32768) throw new Error('默认检索式超过32768字符；原草稿保留，未自动删减检索词');
    for (const key of ['publicationYearFrom', 'publicationYearTo']) parsed[key] = take(key, null);
    for (const key of ['studyTypes', 'inclusion', 'exclusion', 'targetFields']) parsed[key] = take(key, []);
    normalizeLiteratureDraftRules(parsed, message => notices.push(message));
    parsed.limit = take('limit', 10);
    for (const key of ['searchMode', 'stopMode', 'perSourceLimit', 'version']) if (own(config, key) || own(baseline, key)) parsed[key] = take(key, null);
    if (own(config, 'scholarPlan') || own(baseline, 'scholarPlan')) {
      const value = take('scholarPlan', null);
      if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('谷歌学术分批计划必须为对象；清空请明确使用 null');
      if (value != null) parsed.scholarPlan = value;
    }
    for (const key of ['screeningPolicy', 'researchPlan']) {
      if (own(config, key) || own(baseline, key)) {
        const value = take(key, null);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('已确认方案与筛选规则须保留完整对象，不能隐式清空');
        parsed[key] = value;
      }
    }
    if (own(config, 'sourceQueries')) {
      if (!config.sourceQueries || typeof config.sourceQueries !== 'object' || Array.isArray(config.sourceQueries)
        || Object.values(config.sourceQueries).some(value => typeof value !== 'string')) {
        throw new Error('各来源检索式格式无效：须为来源标识对应字符串的对象；原草稿保留');
      }
      if (Object.values(config.sourceQueries).some(value => value.length > 32768)) throw new Error('各来源检索式每项最多32768字符；原草稿保留，未自动删减检索词');
      const entries = Object.entries(config.sourceQueries);
      if (entries.some(([key, value]) => !knownSources.includes(key) || !value.trim())) throw new Error('各来源检索式含未知来源或空白文本；未隐式删除旧式，清空整组请明确使用 {}');
      const prior = baseline.sourceQueries && typeof baseline.sourceQueries === 'object' && !Array.isArray(baseline.sourceQueries) ? baseline.sourceQueries : {};
      parsed.sourceQueries = entries.length ? { ...copy(prior), ...Object.fromEntries(entries.map(([key, value]) => [key, value.trim()])) } : {};
      if (entries.length && Object.keys(prior).some(key => !own(config.sourceQueries, key))) notices.push('部分来源检索式未更新，沿用当前草稿对应值；仍需核对。');
    } else if (baseline.sourceQueries !== undefined) { parsed.sourceQueries = JSON.parse(JSON.stringify(baseline.sourceQueries)); notices.push('各来源检索式未更新，沿用当前草稿；省略不表示清空，仍需核对。'); }
    const extraNames = { batch: '分批设置', fieldDefinitions: '字段定义', templates: '交付模板', fulltext: '全文设置', extraction: '提取设置', limits: '阶段边界' }, unchanged = [];
    Object.keys(extraNames).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(config, key)) {
        if (Object.prototype.hasOwnProperty.call(baseline, key)) { parsed[key] = JSON.parse(JSON.stringify(baseline[key])); unchanged.push(extraNames[key]); }
        return;
      }
      const value = config[key];
      if (key === 'fieldDefinitions') {
        if (!Array.isArray(value) || !value.every(field => field && typeof field === 'object' && !Array.isArray(field))) throw new Error('字段定义必须是对象列表；清空请明确使用 []');
        parsed[key] = value; return;
      }
      if (value === null) { parsed[key] = null; return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(extraNames[key] + '必须是对象；清空请明确使用 null');
      const prior = baseline[key] && typeof baseline[key] === 'object' && !Array.isArray(baseline[key]) ? baseline[key] : {};
      if (Object.keys(prior).some(child => !Object.prototype.hasOwnProperty.call(value, child))) unchanged.push(extraNames[key] + '部分内容');
      parsed[key] = { ...JSON.parse(JSON.stringify(prior)), ...value };
    });
    if (unchanged.length) notices.push(unchanged.join('、') + '未更新，沿用当前草稿；省略不表示清空，仍需逐项核查。');
    if (inherited.length) notices.push('省略的来源、研究范围或执行设置沿用当前草稿（' + inherited.join('、') + '）；未自动确认。');
    const hasBaseline = Object.keys(baseline).some(key => allowed.includes(key));
    let result;
    if (!hasBaseline || own(config, 'searchMode') && config.searchMode !== baseline.searchMode) {
      result = newLiteratureSearchConfig(parsed);
      if (hasBaseline) result.sources = parsed.sources;
    } else {
      result = parsed;
      if (result.searchMode !== undefined && !['test', 'formal'].includes(result.searchMode)) throw new Error('请选择测试运行或正式检索；原草稿保留');
      if (result.stopMode != null && !['count', 'end'].includes(result.stopMode)) throw new Error('检索停止方式必须是 count 或 end；原草稿保留');
    }
    if (notices.length) options.onFormatNotice?.(notices.join('\n'));
    return result;
  }
  function literaturePrepareFailure(phase, error) {
    const network = error.transport === true || /Failed to fetch|NetworkError|Load failed/i.test(error.message || '');
    const routing = /workspace routing discovery (?:failed|timed out)/i.test(error.message || '');
    return phase + '失败：' + (routing ? 'Codex 工作区连接失败，请检查连接后再整理。' : network ? '与本地工作台的连接中断。' : error.message) + ' 原规则、确认记录和已有结果保留。';
  }
  function literaturePrepareReviewSignature(mod) {
    const review = task(mod.id).literatureRuleReview || saved[mod.id]?.literatureRuleReview;
    return JSON.stringify({ id: review?.id || saved[mod.id]?.literatureRuleReviewId || null, revision: review?.revision ?? null,
      ready: review?.ready === true, appliedRevision: saved[mod.id]?.literatureReviewAppliedRevision ?? null });
  }
  function literaturePrepareBasis(mod) {
    // Store returns a clone. Re-read it rather than relying on the object from
    // the original click after an asynchronous session request or poll.
    const fresh = typeof Store === 'undefined' ? mod : Store.getState().modules?.find(item => item.id === mod.id);
    if (!fresh) return null;
    const t = task(mod.id), messages = (fresh.messages || []).filter(message => ['user', 'assistant'].includes(message.role))
      .map(message => ({ role: message.role, text: message.text }));
    const approvedDoc = fresh.doc?.status === 'approved' ? fresh.doc.content : '', baseline = t.literatureConfig ? JSON.parse(JSON.stringify(t.literatureConfig)) : null;
    return { messages, approvedDoc, baseline, source: literatureSource(fresh), configSignature: JSON.stringify(baseline),
      contextSignature: JSON.stringify({ messages, approvedDoc }), reviewSignature: literaturePrepareReviewSignature(mod),
      until: t.literatureUntil || 'discover', selectedMode: t.literatureConfig?.searchMode || saved[mod.id]?.literatureDraftMode,
      model: t.model || account?.model || null };
  }
  function saveLiteraturePreparation(mod, pending, manager, required = false) {
    const t = task(mod.id), previousClient = saved[mod.id], previousPending = t.literaturePreparePending;
    const previousRaw = localStorage.getItem(key);
    const next = { ...saved[mod.id] }; if (pending) next.literaturePreparePending = pending; else delete next.literaturePreparePending;
    saved[mod.id] = next; t.literaturePreparePending = pending;
    try {
      localStorage.setItem(key, JSON.stringify(saved));
      const stored = manager?.saveActive(); if (stored?.ok === false) throw new Error(stored.error || '文献任务快照未能保存');
    } catch (error) {
      if (required) {
        saved[mod.id] = previousClient; t.literaturePreparePending = previousPending;
        try { if (previousRaw === null) localStorage.removeItem(key); else localStorage.setItem(key, previousRaw); } catch (_) {}
      }
      throw new Error('整理进度未能可靠保存：' + error.message + (pending?.id ? '。已受理编号 ' + pending.id + '，请保留当前页面后检查进度。' : '。尚未再次提交。'));
    }
  }
  async function checkLiteraturePrepareProgress(mod, initialJob = null, options = {}) {
    const t = task(mod.id), pending = t.literaturePreparePending || saved[mod.id]?.literaturePreparePending;
    if (!pending?.id || t.literatureBusy && !initialJob) return;
    if (['failed', 'unavailable', 'basis_changed'].includes(pending.status) || pending.status === 'invalid_result' && options.retryInvalid !== true) {
      t.literatureError = literaturePrepareFailure('本次规则整理', new Error(pending.error || '该次整理已结束或不能应用。')) + ' 可显式结束本次等待，再按当前内容重新整理。'; render(); return;
    }
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
    const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId && (!manager || manager.active()?.id === workspaceId)
      && saved[mod.id]?.sessionId === pending.sessionId && (t.literaturePreparePending || saved[mod.id]?.literaturePreparePending)?.id === pending.id;
    if (pending.projectId !== projectId || pending.workspaceId !== workspaceId || saved[mod.id]?.sessionId !== pending.sessionId) {
      t.literatureError = '整理记录不属于当前文献任务或文件会话，未读取或应用。请回到原文献任务检查。'; render(); return;
    }
    t.literatureBusy = true; t.literatureError = ''; render();
    let phase = '读取整理进度';
    try {
      let job = initialJob || pending.resultSnapshot || null, deadline = Date.now() + 10 * 60 * 1000;
      while (true) {
        if (!job) job = await request('/api/codex/job?id=' + encodeURIComponent(pending.id));
        if (!current()) return;
        if (job.status !== 'running' && job.status !== 'queued') break;
        if (Date.now() >= deadline) throw new Error('等待超过10分钟，可稍后点击“检查整理进度”；不会重新提交。');
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (!current()) return; job = null;
      }
      if (job.id !== pending.id || job.sessionId && job.sessionId !== pending.sessionId) throw new Error('返回的整理运行编号或文件会话不匹配，未应用结果');
      if (job.status !== 'completed') {
        pending.status = 'failed'; pending.error = job.error || '本次整理未完成';
        saveLiteraturePreparation(mod, pending, manager); throw new Error(pending.error);
      }
      phase = '读取整理结果';
      // Keep the received reply before parsing it. A format rejection is not a
      // reason to lose the only copy or run the model a second time.
      if (!pending.resultSnapshot) {
        pending.resultSnapshot = { id: job.id, sessionId: pending.sessionId, status: 'completed', text: job.text, model: job.model || null };
        saveLiteraturePreparation(mod, pending, manager);
      }
      const basis = literaturePrepareBasis(mod);
      if (!basis || basis.source !== pending.source || basis.contextSignature !== pending.contextSignature || basis.configSignature !== pending.configSignature
        || basis.until !== pending.until || basis.reviewSignature !== pending.reviewSignature) {
        pending.status = 'basis_changed'; saveLiteraturePreparation(mod, pending, manager);
        throw new Error('讨论、配置或执行阶段已变化，本次旧结果未套用。结果编号已保留，可结束本次整理后按当前要求重新整理。');
      }
      let notice = '';
      const config = parseLiteratureConfig(job.text, { baseline: pending.baseline, onFormatNotice: message => { notice = message; } });
      const hasBaseline = pending.baseline && Object.keys(pending.baseline).length > 0;
      const nextConfig = !hasBaseline && pending.selectedMode === 'formal'
        ? newLiteratureSearchConfig({ ...config, searchMode: 'formal', stopMode: 'end', perSourceLimit: null }) : config;
      const next = { ...saved[mod.id], literatureConfig: nextConfig, literatureSource: pending.source, literatureConfigNotice: notice,
        literatureReviewNeedsSync: true, literatureRuleReview: t.literatureRuleReview ? { ...t.literatureRuleReview, ready: false, needsSync: true } : null };
      delete next.literaturePreparePending; delete next.literatureReviewAppliedRevision;
      phase = '保存整理草稿';
      commitLiteratureRevision(mod, next, { literatureConfig: nextConfig, literatureConfigNotice: notice, literaturePreparePending: null,
        literatureRuleReview: next.literatureRuleReview, literatureReviewNeedsSync: true }, manager);
      return { ok: true, id: pending.id };
    } catch (error) {
      if (current()) {
        if (error.message.includes('运行记录不存在') || error.status === 404) {
          pending.status = 'unavailable'; pending.error = '本次文字整理的运行记录已不存在，后台可能已重启。';
          try { saveLiteraturePreparation(mod, pending, manager); } catch (_) {}
        }
        if (phase === '读取整理结果' && ['accepted', 'invalid_result'].includes(pending.status)) { pending.status = 'invalid_result'; pending.error = error.message; try { saveLiteraturePreparation(mod, pending, manager); } catch (_) {} }
        t.literatureError = literaturePrepareFailure(phase, error) + (pending.status === 'accepted' ? ' 点击“检查整理进度”找回同一次整理，不会重新生成。' : '');
      }
    } finally { if (task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId && (!manager || manager.active()?.id === workspaceId) && saved[mod.id]?.sessionId === pending.sessionId) { t.literatureBusy = false; render(); } }
  }
  function endLiteraturePreparation(mod) {
    const t = task(mod.id), pending = t.literaturePreparePending || saved[mod.id]?.literaturePreparePending;
    if (!pending || t.literatureBusy) return false;
    try {
      saveLiteraturePreparation(mod, null, literatureWorkspaceManager(mod), true);
      t.literatureError = '已结束页面对本次整理的等待。未停止后台任务，原草稿和确认记录未改动；再次点击“从对话更新规则并核查”才会发起新的整理。';
      render(); return true;
    }
    catch (error) { t.literatureError = error.message; } render(); return false;
  }
  async function checkLiteraturePrepareConnection(mod) {
    const t = task(mod.id), pending = t.literaturePreparePending || saved[mod.id]?.literaturePreparePending;
    if (!pending || t.literatureBusy) return;
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
    const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId && (!manager || manager.active()?.id === workspaceId)
      && saved[mod.id]?.sessionId === pending.sessionId && (t.literaturePreparePending || saved[mod.id]?.literaturePreparePending) === pending;
    if (!current()) return;
    try {
      await request('/api/literature/runtime');
      if (!current()) return;
      t.literatureError = '本地后台现已连接。但上次提交没有运行编号，仍不能判断是否已受理；没有重新发送。可继续等待，或显式“放弃本次等待”后再决定是否新提交。';
    } catch (error) { if (!current()) return; t.literatureError = literaturePrepareFailure('检查本地连接', error); } render();
  }
  async function prepareLiterature(mod) {
    const t = task(mod.id);
    const previousPending = t.literaturePreparePending || saved[mod.id]?.literaturePreparePending;
    if (previousPending) {
      if (previousPending.id) return await checkLiteraturePrepareProgress(mod);
      t.literatureError = '上一次整理请求的受理状态未知。原草稿保留；为避免重复生成，尚未再次提交。请先检查本地连接和原会话状态。'; render(); return;
    }
    if (t.literatureBusy || t.busy) return;
    const projectId = root.TaskManager?.currentTaskId?.() || '', manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id || mod.id;
    const current = () => task(mod.id) === t && (root.TaskManager?.currentTaskId?.() || '') === projectId
      && (!manager || manager.active()?.id === workspaceId) && (!pending || saved[mod.id]?.sessionId === pending.sessionId);
    const basis = literaturePrepareBasis(mod);
    if (!basis?.messages.some(message => message.role === 'user')) { t.literatureError = '当前模块还没有用户提出的检索需求；请先讨论主题与检索规则'; render(); return; }
    t.literatureBusy = true; t.literatureError = ''; render();
    let pending = null, phase = '连接文件会话', submitted = false;
    try {
      const sid = await session(mod.id);
      if (!current()) return;
      const freshBasis = literaturePrepareBasis(mod);
      if (JSON.stringify(freshBasis) !== JSON.stringify(basis)) { t.literatureError = '连接会话期间讨论、配置、模型或确认版本已变化，尚未提交整理。请按当前内容重新点击。'; return; }
      pending = { status: 'submitting', projectId, workspaceId, sessionId: sid, source: basis.source, baseline: basis.baseline, until: basis.until,
        selectedMode: basis.selectedMode, configSignature: basis.configSignature, contextSignature: basis.contextSignature,
        reviewSignature: basis.reviewSignature, submittedAt: new Date().toISOString() };
      phase = '保存整理提交标记'; saveLiteraturePreparation(mod, pending, manager, true);
      phase = '提交规则整理'; submitted = true;
      const started = await request('/api/literature/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, messages: basis.messages, currentConfig: basis.baseline, until: basis.until, model: basis.model, approvedDoc: basis.approvedDoc }) });
      if (!current()) return;
      if (!started?.id) throw new Error('后台未返回整理运行编号，无法确认是否受理。');
      pending = { ...pending, id: started.id, status: 'accepted' }; phase = '保存已受理整理编号'; saveLiteraturePreparation(mod, pending, manager);
      return await checkLiteraturePrepareProgress(mod, started);
    } catch (error) {
      if (current()) {
        if (submitted && !pending?.id) {
          const uncertain = error.transport === true || !error.status;
          if (uncertain) { pending.status = 'unknown'; try { saveLiteraturePreparation(mod, pending, manager); } catch (_) {} }
          else try { saveLiteraturePreparation(mod, null, manager, true); } catch (_) {}
          t.literatureError = literaturePrepareFailure(phase, error) + (uncertain ? ' 本次提交受理状态未知，未自动重发；请先检查本地连接和原会话状态。' : ' 后台已拒绝本次请求，可修正后再整理。');
        } else t.literatureError = literaturePrepareFailure(phase, error) + (pending?.id ? ' 点击“检查整理进度”读取已受理任务，不会再次提交。' : '');
      }
    } finally { if (current()) { t.literatureBusy = false; render(); } }
  }
  async function prepareLiteratureAndReview(mod, options = {}) {
    const t = task(mod.id), projectId = root.TaskManager?.currentTaskId?.() || '';
    const manager = literatureWorkspaceManager(mod), workspaceId = manager?.active()?.id;
    const result = options.retryResult === true ? await checkLiteraturePrepareProgress(mod, null, { retryInvalid: true }) : await prepareLiterature(mod);
    if (!result?.ok || task(mod.id) !== t || (root.TaskManager?.currentTaskId?.() || '') !== projectId
      || (manager && manager.active()?.id !== workspaceId) || t.literaturePreparePending || !t.literatureReviewNeedsSync) return;
    const fresh = Store.getState().modules.find(item => item.id === mod.id);
    if (!fresh || Store.getState().activeModuleId !== mod.id || saved[mod.id]?.literatureSource !== literatureSource(fresh)) return;
    return openLiteratureRuleReview(fresh, { draft: true });
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
    'results_unrecognized': '待核对检索页面', 'awaiting_confirmation': '等待确认字段', 'awaiting_segment_confirmation': '等待确认执行范围',
    'completed': '已完成', 'failed': '失败', 'cancelled': '已停止', 'interrupted': '已中断', 'running': '进行中' };
  const LITERATURE_STAGE_STATES = { 'pending': '待运行', 'running': '进行中', 'done': '已完成', 'failed': '失败', 'skipped': '已跳过' };
  const LITERATURE_COUNTER_LABELS = { 'candidates': '候选', 'uniqueGroups': '去重组', 'fulltextFetched': '已获取全文',
    'fulltextPdf': 'PDF正文', 'fulltextHtml': '网页正文文本', 'fulltextPartial': '正文结构不完整',
    'fulltextComplete': '正文完整', 'materialsComplete': '补材无已知缺口', 'materialsPartial': '补材部分取得',
    'materialsUnverified': '补充材料未核查',
    'fulltextAbstract': '仅题录/摘要（非全文）', 'fulltextUnavailable': '待补充',
    'fulltextAttention': '待人工处理', 'fulltextPending': '尚未处理', 'fulltextSkipped': '本轮跳过（含补材）',
    'materialsIncomplete': '材料不完整', 'extractedPapers': '已提取论文', 'parameterRows': '参数行' };
  const LITERATURE_UNTIL_OPTIONS = [['discover', '仅检索候选'], ['dedupe', '续跑到去重'], ['fulltext', '续跑到全文获取'],
    ['extract', '续跑到参数提取'], ['validate', '续跑到校验'], ['export', '完整流水线']];
  const LITERATURE_STATUS_LABELS = { 'running': '进行中', 'completed': '已完成', 'needs_attention': '需要人工', 'failed': '失败', 'cancelled': '已停止' };
  function literatureJobStatusLabel(job) {
    return job.stage === 'prepared' && job.status === 'needs_attention' ? '待开始检索' : (LITERATURE_STATUS_LABELS[job.status] || job.status || '未知');
  }
  // 检索来源固定为五库。PubMed/PMC/OpenAlex/Europe PMC/Semantic Scholar 已按五库口径
  // 移出可选列表（注册表标记 registered）；PMC/Europe PMC 仍作为全文与补充材料解析器。
  const LITERATURE_SOURCE_LABELS = { 'google-scholar': 'Google Scholar', 'cnki': '中国知网', 'web-of-science': 'Web of Science 核心合集',
    'wanfang': '万方', 'scopus': 'Scopus' };
  // 可使用平台专用浏览器的来源。PubMed 默认走 API，仅在已转官方网页且
  // 实际等待登录/验证时显示浏览器入口；其他开放 API 源不在此列。
  const LITERATURE_EXECUTABLE_SOURCES = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus'];
  const LITERATURE_FILE_LABELS = { 'run_config.json': '运行配置（冻结）', 'rule-review-confirmed.json': '已确认配置与逐项核查记录', 'processing-basis.json': '本次处理依据', 'candidates.json': '候选清单 JSON（累计）', 'candidates.csv': '候选清单 CSV（累计）',
    'dedupe/dedupe.json': '去重结果 JSON', 'dedupe/dedupe.csv': '去重结果 CSV', 'fulltext/status.json': '全文获取状态',
    'fulltext/review.json': '全文缓存复核报告', 'fulltext/materials.json': '每篇材料清单 JSON',
    'extraction/check_report.json': '提取校验报告', 'validation/validation.json': '校验结果 JSON', 'validation/validation.md': '待审核清单',
    'export/literature.csv': '文献表 CSV', 'export/literature.xlsx': '文献表 Excel', 'export/parameters.csv': '参数明细表 CSV',
    'export/parameters.xlsx': '参数明细表 Excel', 'export/export_report.md': '导出报告',
    'fulltext/manual-actions.json': '人工待处理清单 JSON', 'fulltext/manual-actions.csv': '人工待处理清单 CSV',
    'fulltext/manual-actions.md': '人工待处理清单说明',
    'fulltext/skipped-materials.json': '已跳过材料缺口 JSON', 'fulltext/skipped-materials.csv': '已跳过材料缺口 CSV',
    'fulltext/skipped-materials.md': '已跳过材料缺口说明' };
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
    const disclosureState = literatureDeliverables.disclosureState ||= new Map();
    const rememberDisclosure = (details, summary, groupKey, initiallyOpen = false) => {
      const key = JSON.stringify([job.id, groupKey]);
      details.open = disclosureState.has(key) ? disclosureState.get(key) : initiallyOpen;
      summary.onclick = () => disclosureState.set(key, !details.open);
      details.ontoggle = () => { if (details.isConnected) disclosureState.set(key, details.open); };
    };
    const link = name => {
      const anchor = node('a', literatureFileLabel(name));
      anchor.href = '/api/literature/download?id=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(name);
      anchor.title = name;
      return anchor;
    };
    const counts = job.counters || {};
    const gaps = [
      ['materialsIncomplete', '材料不完整'], ['fulltextPartial', '正文不完整'],
      ['fulltextUnavailable', '全文待补'], ['fulltextAttention', '待人工处理']
    ].filter(([key]) => Number.isInteger(counts[key]) && counts[key] > 0)
      .map(([key, label]) => label + ' ' + counts[key] + ' 篇');
    if (!gaps.length) {
      for (const [key, label] of [['materialsPartial', '补充材料不全'], ['materialsUnverified', '补充材料未核查']]) {
        if (Number.isInteger(counts[key]) && counts[key] > 0) gaps.push(label + ' ' + counts[key] + ' 篇');
      }
    }
    if (gaps.length) {
      const notice = node('div', undefined, 'literature-deliverable-notice');
      notice.append(node('p', '材料提醒：' + gaps.join(' · ') + '。各项可能重叠，请查看每篇材料清单。'));
      const status = ['fulltext/materials.json', 'fulltext/status.json'].find(name => files.includes(name));
      if (status) notice.append(link(status));
      box.append(notice);
    }
    if (files.includes('validation/validation.md')) {
      const notice = node('div', undefined, 'literature-deliverable-notice');
      notice.append(node('p', '核查提醒：请查看待审核清单并回原件确认；自动校验完成不代表已人工核查。'));
      notice.append(link('validation/validation.md')); box.append(notice);
    }
    const groups = literatureFileGroups(files);
    groups.filter(group => group.key === 'export').concat(groups.filter(group => group.key !== 'export')).forEach(group => {
      const isExport = group.key === 'export';
      const section = node('details', undefined, 'literature-deliverable-group' + (isExport ? ' literature-deliverable-export' : ''));
      const summary = node('summary', (isExport ? '最终导出文件' : group.label) + ' · ' + group.files.length + ' 个', 'literature-deliverable-title');
      rememberDisclosure(section, summary, group.key, isExport);
      section.append(summary);
      if (group.key === 'fulltext') section.append(node('p', '保存了文件不代表已确认全文，请以全文状态和复核报告中的分类为准。', 'codex-status'));
      const list = node('div', undefined, 'literature-deliverable-list');
      const collapsed = group.files.length > 8;
      (collapsed ? group.files.slice(0, 6) : group.files).forEach(name => list.append(link(name)));
      if (collapsed) {
        const more = node('details', undefined, 'literature-deliverable-more');
        const moreSummary = node('summary', '展开其余 ' + (group.files.length - 6) + ' 个文件');
        rememberDisclosure(more, moreSummary, group.key + ':more');
        more.append(moreSummary);
        const inner = node('div', undefined, 'literature-deliverable-list');
        group.files.slice(6).forEach(name => inner.append(link(name)));
        more.append(inner); list.append(more);
      }
      section.append(list); box.append(section);
    });
    return box;
  }
  function literatureDiscoveryProgress(job) {
    const progress = job?.discoveryProgress;
    if (!progress || progress.source !== 'google-scholar') return null;
    const box = node('section', undefined, 'literature-confirm literature-discovery-progress'); box.setAttribute('aria-live', 'polite');
    box.append(node('h4', progress.trialMaxPages != null ? '谷歌学术预试进度（仅候选）' : '谷歌学术分批进度'));
    const batch = [];
    if (progress.batchLabel) batch.push(progress.batchLabel);
    if (Number.isInteger(progress.yearFrom) && Number.isInteger(progress.yearTo)) batch.push(progress.yearFrom + '—' + progress.yearTo);
    if (batch.length) box.append(node('p', '当前批次：' + batch.join(' · '), 'codex-status'));
    const counts = [];
    if (Number.isInteger(progress.pagesSaved) && progress.pagesSaved >= 0) counts.push('计划累计已保存 ' + progress.pagesSaved + ' 页');
    if (Number.isInteger(progress.nextPage) && progress.nextPage >= 1) counts.push('下次检查第 ' + progress.nextPage + ' 页');
    if (Number.isInteger(progress.processedBatches) && progress.processedBatches >= 0) counts.push('已处理批次 ' + progress.processedBatches);
    if (Number.isInteger(progress.pendingBatches) && progress.pendingBatches >= 0) counts.push('待继续批次 ' + progress.pendingBatches);
    if (counts.length) box.append(node('p', counts.join(' · '), 'codex-status'));
    if (Number.isInteger(progress.coverageGaps) && progress.coverageGaps > 0) box.append(node('p', '覆盖缺口：' + progress.coverageGaps + ' 项，仍有受限或未完成的批次；不能视为检全。', 'codex-error'));
    const statuses = { pending: '当前批次待继续；已有候选保留。', processed: '当前批次已处理，完整覆盖情况以批次记录和缺口为准。',
      coverage_limited: '当前批次覆盖受限，已保存断点和缺口。', trial_complete: '已到本次预试页数上限，预试结束；这只验证一小部分，不代表完整检索。' };
    if (statuses[progress.status]) box.append(node('p', statuses[progress.status], 'codex-status'));
    if (progress.recoveryMessage) box.append(node('p', progress.recoveryMessage, 'codex-status'));
    box.append(node('p', '刷新页面只读取已保存进度；需要继续时请显式操作，不会因刷新重新发起检索。', 'codex-status'));
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
      ['candidates', 'fulltextFetched', 'extractedPapers', 'parameterRows'].forEach(key => {
        if (typeof job.counters[key] === 'number') meta.push((LITERATURE_COUNTER_LABELS[key] || key) + ' ' + job.counters[key]);
      });
    }
    if (meta.length) bar.append(node('span', meta.join(' · '), 'literature-stage-meta'));
    const counterKeys = Object.keys(job.counters || {}).filter(key => typeof job.counters[key] === 'number');
    if (counterKeys.length) {
      const details = node('details', undefined, 'literature-stage-statistics');
      const summary = node('summary', '详细统计 · ' + counterKeys.length + ' 项');
      const disclosureState = literatureStageBar.disclosureState ||= new Map();
      details.open = disclosureState.get(job.id) === true;
      summary.onclick = () => disclosureState.set(job.id, !details.open);
      details.ontoggle = () => { if (details.isConnected) disclosureState.set(job.id, details.open); };
      const list = node('div', undefined, 'literature-statistics-grid');
      counterKeys.forEach(key => list.append(node('span', (LITERATURE_COUNTER_LABELS[key] || key) + ' ' + job.counters[key])));
      details.append(summary, list); bar.append(details);
    }
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
    literatureFieldDrafts[job.id] = { ...literatureFieldDrafts[job.id], fields: JSON.parse(JSON.stringify(t.literatureConfirmDrafts)) };
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
    if (drafts.length >= 200) { t.literatureFieldsError = '每个任务最多设置200个提取字段。'; renderLiteratureFieldsDialog(); return; }
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
    if (drafts.length > 200) throw new Error('每个任务最多设置200个提取字段。');
    const fields = drafts.map(draft => {
      const field = { ...JSON.parse(JSON.stringify(draft)), key: String(draft.key || '').trim(), label: String(draft.label || '').trim(),
        meaning: String(draft.meaning || '').trim(), unit: String(draft.unit || '').trim(), valueType: draft.valueType || 'text', required: draft.required === true };
      if (draft.conditionKeys !== undefined) {
        const keys = typeof draft.conditionKeys === 'string' ? draft.conditionKeys.split(/[,，]/) : draft.conditionKeys;
        if (!Array.isArray(keys) || keys.length > 32 || keys.some(key => typeof key !== 'string' || key.trim().length > 100)) throw new Error('关联条件请用逗号分隔，最多32项，每项不超过100字。');
        field.conditionKeys = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
      }
      return field;
    });
    if (fields.some(field => !field.key || field.key.length > 100)) throw new Error('字段标识无效，请删除该行后重新新增。');
    if (new Set(fields.map(field => field.key)).size !== fields.length) throw new Error('字段标识重复，请删除重复行后重新新增。');
    if (fields.some(field => !field.label || field.label.length > 200)) throw new Error('请为每个字段填写表头名称（最多200字）。');
    if (new Set(fields.map(field => field.label)).size !== fields.length) throw new Error('表头名称不能重复，请明确区分不同字段。');
    if (fields.some(field => !field.meaning || field.meaning.length > 500)) throw new Error('请填写每个字段的含义（最多500字）。');
    if (fields.some(field => field.unit.length > 100 || (field.valueType === 'number' && !field.unit))) throw new Error('请明确数值字段的单位，可填写“无量纲”或“原文单位”（最多100字）。');
    if (fields.some(field => !['text', 'number'].includes(field.valueType))) throw new Error('字段类型仅支持文本或数值。');
    if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > 60 * 1024) throw new Error('字段说明总量超过单次确认容量，请精简含义或其他字段规则后再确认；草稿会保留。');
    return fields;
  }
  function literatureFieldsAssistState(mod, job) {
    const record = literatureFieldDrafts[job.id] ||= {};
    record.assists ||= {};
    return record.assists[mod.id] ||= { discussions: [], input: '', preview: null, previousFields: null, pending: null, error: '' };
  }
  function saveLiteratureFieldsAssist(t) {
    try { localStorage.setItem(literatureFieldDraftKey, JSON.stringify(literatureFieldDrafts)); return true; }
    catch (_) { t.literatureFieldsError = '字段讨论暂时无法保存到浏览器，请保留当前页面并检查浏览器存储空间。'; return false; }
  }
  function literatureFieldsAssistSignature(mod, t, state) {
    mod = Store.getState?.().modules?.find(item => item.id === mod.id) || mod;
    return JSON.stringify({ fields: t.literatureConfirmDrafts || [], discussions: state.discussions, input: state.input,
      background: (mod.messages || []).filter(item => ['user', 'assistant'].includes(item.role)).slice(-30),
      approvedDoc: mod.doc?.status === 'approved' ? mod.doc.content : '' });
  }
  function parseLiteratureFieldsPreview(text) {
    let value;
    try { value = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch (_) { throw new Error('AI 返回的字段草稿格式不完整，原字段没有改变，请重试整理。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.fields)) throw new Error('AI 返回的字段草稿缺少 fields 清单，原字段没有改变。');
    if (value.fields.length > 200) throw new Error('AI 草稿超过200个字段，请讨论取舍或分批；原字段没有改变。');
    const fields = value.fields.map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field)
        || ['key', 'label', 'meaning', 'unit'].some(key => typeof field[key] !== 'string')
        || !['text', 'number'].includes(field.valueType) || typeof field.required !== 'boolean') throw new Error('AI 字段的名称、含义、单位或类型不完整，原字段没有改变。');
      return { key: field.key.trim(), label: field.label.trim(), meaning: field.meaning.trim(), unit: field.unit.trim(), valueType: field.valueType, required: field.required,
        ...(field.conditionKeys !== undefined ? { conditionKeys: field.conditionKeys } : {}) };
    });
    const validated = fields.length ? validatedLiteratureFields({ literatureConfirmDrafts: fields }) : fields;
    if (new Set(fields.map(field => field.key.toLocaleLowerCase())).size !== fields.length
      || new Set(fields.map(field => field.label.toLocaleLowerCase())).size !== fields.length) throw new Error('AI 字段存在重复标识或表头，请重新整理。');
    const lines = value => {
      const items = value === undefined ? [] : typeof value === 'string' ? [value] : value;
      if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('AI 待确认事项格式无效，请重新整理。');
      return items.filter(item => item.trim()).map(item => item.trim());
    };
    return { fields: validated, unresolved: lines(value.unresolved), notes: lines(value.notes) };
  }
  async function watchLiteratureFieldsAssist(mod, jobId) {
    const t = task(mod.id), state = literatureFieldsAssistState(mod, { id: jobId });
    const pending = state.pending, watchKey = mod.id + ':' + jobId;
    if (!pending?.id || literatureFieldsAssistWatchers.has(watchKey)) return;
    literatureFieldsAssistWatchers.add(watchKey);
    t.literatureFieldsAssistBusy = jobId;
    let fillTable = false;
    try {
      let result;
      const deadline = Date.now() + 10 * 60 * 1000;
      do {
        result = await request('/api/codex/job?id=' + encodeURIComponent(pending.id));
        if (result.status !== 'running') break;
        if (Date.now() >= deadline) throw new Error('AI 回复等待超时，讨论和字段草稿已保留。可点击“检查 AI 回复”，不会重新发送。');
        await new Promise(resolve => setTimeout(resolve, 1200));
      } while (state.pending === pending);
      if (state.pending !== pending) return;
      if (result.status !== 'completed') throw Object.assign(new Error(result.error || 'AI 未完成回复，请重试；原字段草稿保留。'), { terminal: true });
      if (pending.mode === 'draft') {
        let preview;
        try { preview = parseLiteratureFieldsPreview(result.text); } catch (error) { error.terminal = true; throw error; }
        state.preview = { ...preview, signature: pending.signature };
        fillTable = pending.autoApply === true && preview.fields.length > 0;
      } else {
        if (!String(result.text || '').trim()) throw Object.assign(new Error('AI 回复为空，请重试。'), { terminal: true });
        state.discussions.push({ role: 'assistant', text: String(result.text).trim() });
      }
      state.pending = null; state.retry = null; state.error = '';
    } catch (error) {
      state.error = error.message;
      // Keep an accepted AI job id after a network/timeout error; check it before any retry.
      if (error.terminal || [400, 403, 404].includes(error.status)) { state.pending = null; state.retry = { mode: pending.mode, autoApply: pending.autoApply === true }; }
    } finally {
      literatureFieldsAssistWatchers.delete(watchKey);
      if (t.literatureFieldsAssistBusy === jobId) t.literatureFieldsAssistBusy = null;
      if (fillTable) applyLiteratureFieldsPreview(mod, t, { id: jobId });
      saveLiteratureFieldsAssist(t);
      if (t.literatureJob?.id === jobId) renderLiteratureFieldsDialog();
    }
  }
  async function requestLiteratureFieldsAssist(mod, mode, retry = false, autoApply = false) {
    const t = task(mod.id), job = t.literatureJob;
    if (!job?.id || job.segmentTask?.schemaLocked || t.busy || t.literatureBusy || job.status === 'running' || root.LiteratureUI?.isBusy() || t.literatureFieldsAssistBusy) return;
    ensureLiteratureFieldDrafts(t, job);
    const state = literatureFieldsAssistState(mod, job);
    if (state.pending?.id) { void watchLiteratureFieldsAssist(mod, job.id); return; }
    if (retry) autoApply = state.retry?.autoApply === true;
    if (mode === 'discuss' && !retry) {
      const text = state.input.trim();
      if (!text) { state.error = '请先写下想讨论的表头、字段含义或单位问题。'; renderLiteratureFieldsDialog(); return; }
      if (text.length > 6000) { state.error = '单条讨论请控制在6000字以内。'; renderLiteratureFieldsDialog(); return; }
      if (state.discussions.length >= 60) { state.error = '字段讨论已达到本轮容量，完整讨论仍保留。请先核对、应用已确认的字段草稿，再整理后续讨论；不会自动丢弃前面的规则。'; renderLiteratureFieldsDialog(); return; }
      state.discussions.push({ role: 'user', text }); state.input = '';
    }
    state.error = ''; state.retry = null;
    if (!saveLiteratureFieldDrafts(t, job) || !saveLiteratureFieldsAssist(t)) { renderLiteratureFieldsDialog(); return; }
    const signature = literatureFieldsAssistSignature(mod, t, state);
    const payload = { id: job.id, mode, discussions: JSON.parse(JSON.stringify(state.discussions)),
      message: mode === 'discuss' ? [...state.discussions].reverse().find(item => item.role === 'user')?.text || '' : '',
      currentFields: JSON.parse(JSON.stringify(t.literatureConfirmDrafts)),
      moduleMessages: (mod.messages || []).filter(item => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string' && item.text.trim()).slice(-30).map(item => ({ role: item.role, text: item.text })),
      approvedDoc: mod.doc?.status === 'approved' ? mod.doc.content : '', model: t.model || account?.model };
    t.literatureFieldsAssistBusy = job.id; renderLiteratureFieldsDialog();
    try {
      const sid = await session(mod.id);
      const started = await request('/api/literature/fields-assist', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, sessionId: sid }) });
      if (!started?.id) throw new Error('AI 回复任务缺少编号，请重试。');
      state.pending = { id: started.id, mode, signature, autoApply: mode === 'draft' && autoApply }; saveLiteratureFieldsAssist(t);
      if (t.literatureJob?.id === job.id) renderLiteratureFieldsDialog();
      await watchLiteratureFieldsAssist(mod, job.id);
    } catch (error) { state.error = error.message; state.retry = { mode, autoApply: mode === 'draft' && autoApply }; saveLiteratureFieldsAssist(t); }
    finally { if (t.literatureFieldsAssistBusy === job.id) t.literatureFieldsAssistBusy = null; if (t.literatureJob?.id === job.id) renderLiteratureFieldsDialog(); }
  }
  function applyLiteratureFieldsPreview(mod, t, job) {
    const state = literatureFieldsAssistState(mod, job), preview = state.preview;
    if (t.literatureJob?.id !== job.id || t.busy || t.literatureBusy || t.literatureJob.status === 'running' || t.literatureFieldsAssistBusy || state.pending || root.LiteratureUI?.isBusy() || !preview?.fields?.length) {
      if (preview?.fields?.length) state.error = 'AI 已整理字段，但当前任务已切换或正在运行；请回到原任务核对后再填入表格。';
      return;
    }
    if (preview.signature !== literatureFieldsAssistSignature(mod, t, state)) { state.error = '字段或讨论已有变化，请重新整理候选草稿后再应用。'; renderLiteratureFieldsDialog(); return; }
    try {
      const fields = validatedLiteratureFields({ literatureConfirmDrafts: preview.fields });
      const previousFields = JSON.parse(JSON.stringify(t.literatureConfirmDrafts));
      t.literatureConfirmDrafts = fields.map(field => ({ ...JSON.parse(JSON.stringify(previousFields.find(prior => prior.key === field.key) || {})), ...field }));
      if (!saveLiteratureFieldDrafts(t, job)) {
        t.literatureConfirmDrafts = previousFields;
        literatureFieldDrafts[job.id].fields = JSON.parse(JSON.stringify(previousFields));
        throw new Error(t.literatureFieldsError || '表格暂时无法保存，原字段已保留，请重试。');
      }
      state.previousFields = previousFields;
      state.applied = { count: fields.length, unresolved: preview.unresolved, notes: preview.notes };
      state.error = ''; state.preview = null;
      saveLiteratureFieldsAssist(t); renderLiteratureFieldsDialog();
    } catch (error) { state.error = error.message; renderLiteratureFieldsDialog(); }
  }
  function literatureFieldsAssistForm(mod, t, job) {
    const state = literatureFieldsAssistState(mod, job);
    const busy = t.literatureFieldsAssistBusy === job.id;
    const disabled = t.busy || t.literatureBusy || job.status === 'running' || busy || !!state.pending || !!root.LiteratureUI?.isBusy();
    const box = node('section', undefined, 'literature-fields-assist');
    box.append(node('h3', '讨论并填写提取表格'), node('p', '先与 AI 讨论，再点“按讨论填入表格”，把表头、含义、单位和类型直接填到下方可编辑表格。一列只放一个变量；单位可先约定“原文单位”。核对后由你点击开始提取。', 'codex-status'));
    box.append(node('p', '会参考近期模块对话、已审核方案和下方字段草稿，并保留本任务完整的字段讨论。当前任务的讨论与候选保存在本浏览器。', 'codex-status'));
    const thread = node('div', undefined, 'literature-fields-thread'); thread.setAttribute('aria-live', 'polite');
    state.discussions.forEach(item => thread.append(node('p', (item.role === 'user' ? '你：' : 'AI：') + item.text, 'literature-fields-message')));
    if (!state.discussions.length) thread.append(node('p', '例如：请把“记录ID、文献ID、研究ID”拆成独立列，并讨论温度和采食量的单位。', 'codex-status'));
    box.append(thread);
    const input = node('textarea', undefined, 'literature-fields-question'); input.setAttribute('aria-label', '与 AI 讨论提取字段'); input.placeholder = '输入字段、表头或单位处理的要求…'; input.maxLength = 6000; input.value = state.input; input.disabled = disabled;
    input.oninput = () => { state.input = input.value; saveLiteratureFieldsAssist(t); updatePreviewState(); };
    box.append(input);
    const actions = node('div', undefined, 'literature-confirm-actions');
    const send = node('button', busy ? 'AI 处理中…' : '发送给 AI', 'quiet-button'); send.type = 'button'; send.disabled = disabled; send.onclick = () => requestLiteratureFieldsAssist(mod, 'discuss');
    const draft = node('button', '按讨论填入表格', 'primary-button'); draft.type = 'button'; draft.disabled = disabled;
    draft.onclick = () => {
      if (state.input.trim()) { state.error = '还有未发送的讨论，请先发送，或清空后再整理字段。'; renderLiteratureFieldsDialog(); return; }
      return requestLiteratureFieldsAssist(mod, 'draft', false, true);
    };
    actions.append(send, draft);
    if (state.error && state.pending && !busy) {
      const check = node('button', '检查 AI 回复', 'quiet-button'); check.type = 'button'; check.disabled = t.busy || t.literatureBusy || job.status === 'running'; check.onclick = () => watchLiteratureFieldsAssist(mod, job.id); actions.append(check);
    } else if (state.retry && !busy) {
      const retry = node('button', '重试 AI 回复', 'quiet-button'); retry.type = 'button'; retry.disabled = disabled; retry.onclick = () => requestLiteratureFieldsAssist(mod, state.retry.mode, true); actions.append(retry);
    }
    if (state.previousFields) {
      const undo = node('button', '恢复应用前草稿', 'quiet-button'); undo.type = 'button'; undo.disabled = disabled;
      undo.onclick = () => { if (undo.disabled || t.literatureJob?.id !== job.id || t.literatureJob.status === 'running') return; t.literatureConfirmDrafts = JSON.parse(JSON.stringify(state.previousFields)); state.previousFields = null; state.preview = null; state.applied = null; saveLiteratureFieldDrafts(t, job); renderLiteratureFieldsDialog(); }; actions.append(undo);
    }
    box.append(actions);
    const status = node('p', state.error || (busy ? 'AI 正在回复' + (state.pending?.id ? '（' + state.pending.id.slice(0, 8) + '）' : '') + '；可临时关闭窗口，返回后查看。按讨论填表完成后，仍需你核对并开始提取。'
      : state.applied ? '已将讨论整理成 ' + state.applied.count + ' 个字段并填入下方表格；请核对表格后开始提取。'
      : '填入表格会保存当前任务的字段草稿；核对表格后再开始提取。'), state.error ? 'codex-error' : 'literature-fields-assist-status');
    status.setAttribute('aria-live', 'polite'); box.append(status);
    if (state.applied) {
      const unresolved = state.applied.unresolved || [], notes = state.applied.notes || [];
      if (unresolved.length || notes.length) {
        const review = node('details', undefined, 'literature-fields-review');
        review.append(node('summary', '查看待核对事项（' + unresolved.length + '）与 AI 整理说明（' + notes.length + '）'));
        unresolved.forEach(text => review.append(node('p', '待确认：' + text, 'literature-fields-assist-status')));
        notes.forEach(text => review.append(node('p', 'AI 说明：' + text, 'codex-status')));
        box.append(review);
      }
    }
    let apply = null, stale = null;
    const updatePreviewState = () => {
      if (!apply) return;
      const changed = state.preview?.signature !== literatureFieldsAssistSignature(mod, t, state);
      apply.disabled = disabled || changed || !state.preview?.fields?.length;
      stale.hidden = !changed;
    };
    t.literatureFieldsPreviewRefresh = updatePreviewState;
    if (state.preview) {
      const preview = node('section', undefined, 'literature-fields-preview'); preview.append(node('h4', 'AI 字段草稿（待你核对）'));
      const table = node('table', undefined, 'literature-fields-preview-table');
      const head = node('tr'); ['表头名称', '含义', '单位', '类型', '必填'].forEach(title => head.append(node('th', title))); table.append(head);
      state.preview.fields.forEach(field => { const row = node('tr'); [field.label, field.meaning, field.unit || '—', field.valueType === 'number' ? '数值' : '文本', field.required ? '是' : '否'].forEach(value => row.append(node('td', value))); table.append(row); });
      preview.append(table);
      if (!state.preview.fields.length) preview.append(node('p', '本次未生成可应用字段，请先讨论以下待确认事项。', 'codex-status'));
      state.preview.unresolved.forEach(text => preview.append(node('p', '待确认：' + text, 'literature-fields-assist-status')));
      state.preview.notes.forEach(text => preview.append(node('p', '说明：' + text, 'codex-status')));
      stale = node('p', '字段或讨论已有变化，这份候选已过期；请重新整理后再应用。', 'codex-error');
      apply = node('button', '填入下方表格', 'quiet-button'); apply.type = 'button'; apply.onclick = () => applyLiteratureFieldsPreview(mod, t, job);
      preview.append(stale, apply); box.append(preview); updatePreviewState();
    }
    if (state.pending?.id && !state.error && !busy && !literatureFieldsAssistWatchers.has(mod.id + ':' + job.id)) void watchLiteratureFieldsAssist(mod, job.id);
    return box;
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
    literatureFieldsDialog.lockStamp = JSON.stringify([job.id, job.status, t.busy, t.literatureBusy, !!root.LiteratureUI?.isBusy()]);
    dialog.replaceChildren();
    const head = node('div', undefined, 'literature-help-head');
    head.append(node('h2', '提取字段与表头'));
    const close = node('button', '关闭', 'quiet-button'); close.type = 'button'; close.onclick = closeLiteratureFields;
    head.append(close); dialog.append(head, literatureFieldsAssistForm(mod, t, job), literatureConfirmForm(mod, t, job));
    const save = node('button', '保存草稿并关闭', 'quiet-button'); save.type = 'button'; save.disabled = t.literatureBusy || t.busy;
    save.onclick = () => { if (saveLiteratureFieldDrafts(t, job)) { closeLiteratureFields(); render(); } else renderLiteratureFieldsDialog(); };
    dialog.append(save);
  }
  function openLiteratureFields(mod) {
    const t = task(mod.id), job = t.literatureJob;
    if (!job?.id || t.literatureBusy || t.busy || job.status === 'running' || job.segmentTask?.schemaLocked) return;
    ensureLiteratureFieldDrafts(t, job);
    closeLiteratureFields();
    const dialog = node('dialog', undefined, 'literature-help-dialog');
    dialog.setAttribute('aria-label', '提取字段与表头');
    dialog.onclose = () => { if (literatureFieldsDialog?.element === dialog) literatureFieldsDialog = null; dialog.remove(); };
    literatureFieldsDialog = { element: dialog, mod, jobId: job.id };
    document.body.append(dialog); renderLiteratureFieldsDialog(); dialog.showModal();
  }
  function closeLiteratureMaterials() {
    if (!literatureMaterialsDialog) return;
    const dialog = literatureMaterialsDialog; literatureMaterialsDialog = null;
    dialog.close(); dialog.remove();
  }
  function renderLiteratureMaterials(dialog, jobId, inventory) {
    const pdf = { pending: '正文PDF尚未取得', downloaded: '正文PDF已保存', missing: '缺少正文PDF', needs_attention: '正文PDF待处理' };
    const checks = { uninspected: '补材尚未检查', checked: '已检查补材入口', none_declared: '原文明确无补充材料', unknown: '补材情况尚不能确认', needs_attention: '补材检查待处理' };
    const downloads = { pending: '尚未下载', downloaded: '已保存', missing: '缺失', needs_attention: '下载待处理' };
    const reads = { not_checked: '未检查读取', readable: '可读取', partial: '部分可读取', unreadable: '不可读取', unsupported: '暂不支持读取原格式' };
    const roles = { main_pdf: '正文PDF', main_html: '网页正文或旧文本缓存', supplement: '补充材料' };
    const content = node('div');
    content.append(node('p', '取得正文不代表补材齐全。此处只查看已保存记录，不会继续当前任务、下载文献或启动提取。', 'codex-status'));
    if (inventory.legacy) content.append(node('p', '这是旧记录的只读清单；未逐项检查的补材显示“尚未检查”，不能理解为没有补材。', 'codex-status'));
    const papers = Array.isArray(inventory.papers) ? inventory.papers : [];
    if (!papers.length) content.append(node('p', '当前任务还没有登记材料。查看不会开始获取。', 'codex-status'));
    papers.forEach(paper => {
      const section = node('details', undefined, 'literature-deliverable-group');
      section.append(node('summary', paper.paper_id + ' · ' + paper.title));
      section.append(node('p', (pdf[paper.main_pdf_status] || '正文PDF状态未知') + '；' + (checks[paper.supplement_check?.status] || checks.unknown)));
      if (paper.supplement_check?.reason) section.append(node('p', paper.supplement_check.reason, 'codex-status'));
      (Array.isArray(paper.materials) ? paper.materials : []).forEach(material => {
        const entry = node('div', undefined, 'literature-confirm');
        entry.append(node('strong', (roles[material.role] || '材料') + ' · ' + (material.label || material.filename || '未命名材料')));
        entry.append(node('p', '文件：' + (material.filename || '尚未生成') + ' · 格式：' + (material.format || '未知')
          + ' · ' + (Number.isSafeInteger(material.size) ? material.size + ' 字节' : '大小未知')));
        entry.append(node('p', '下载：' + (downloads[material.download_status] || '未知') + '；读取：' + (reads[material.read_status] || '未检查读取'), 'codex-status'));
        if (material.download_reason) entry.append(node('p', '保存问题：' + material.download_reason, 'codex-status'));
        if (material.read_reason) entry.append(node('p', material.read_reason, 'codex-status'));
        if (material.reused_from) entry.append(node('p', '已复用本机保存材料，来源任务：' + material.reused_from.job_id + ' · ' + material.reused_from.paper_id, 'codex-status'));
        if (material.available === true && material.path) {
          const link = node('a', '下载已保存文件', 'quiet-button'); link.href = '/api/literature/download?id=' + encodeURIComponent(jobId) + '&name=' + encodeURIComponent(material.path);
          link.setAttribute('download', material.filename || 'material'); entry.append(link);
        }
        section.append(entry);
      });
      if (!paper.materials?.length) section.append(node('p', '尚未保存材料文件；主文和补材状态分别列在上方。', 'codex-status'));
      content.append(section);
    });
    dialog.append(content);
  }
  async function openLiteratureMaterials(mod) {
    const jobId = task(mod.id).literatureJob?.id;
    if (!jobId) return;
    closeLiteratureMaterials();
    const dialog = node('dialog', undefined, 'literature-help-dialog'); dialog.style.width = 'min(1200px, 94vw)'; dialog.style.maxHeight = '90vh';
    dialog.setAttribute('aria-label', '每篇材料清单');
    const head = node('div', undefined, 'literature-help-head'); head.append(node('h2', '每篇材料清单'));
    const close = node('button', '关闭', 'quiet-button'); close.type = 'button'; close.onclick = closeLiteratureMaterials;
    head.append(close); dialog.append(head);
    const notice = node('p', '正在读取本机材料记录…', 'codex-status'); notice.setAttribute('aria-live', 'polite'); dialog.append(notice);
    dialog.onclose = () => { if (literatureMaterialsDialog === dialog) literatureMaterialsDialog = null; dialog.remove(); };
    literatureMaterialsDialog = dialog; document.body.append(dialog); dialog.showModal();
    try {
      const inventory = await request('/api/literature/materials?id=' + encodeURIComponent(jobId));
      if (literatureMaterialsDialog !== dialog) return;
      notice.remove(); renderLiteratureMaterials(dialog, jobId, inventory);
    } catch (error) { if (literatureMaterialsDialog === dialog) { notice.textContent = error.message; notice.className = 'codex-error'; } }
  }
  function literatureConfirmForm(mod, t, job) {
    const box = node('div', undefined, 'literature-confirm');
    const awaitingConfirm = (job.status === 'needs_attention' && job.stage === 'awaiting_confirmation')
      || (job.status === 'cancelled' && job.segmentTask?.fromStage === 'extract' && job.segmentTask.fieldsConfirmed !== true);
    box.append(node('p', awaitingConfirm ? '请核对表头名称、字段含义和单位；确认后继续当前任务的提取。'
      : '先讨论并填写提取字段。保存草稿后可继续获取全文，进入提取阶段时再确认。'));
    box.append(node('p', '当前任务 ' + job.id.slice(0, 8) + ' · 已有候选与全文保留；编辑字段不会重新检索。', 'codex-status'));
    const drafts = ensureLiteratureFieldDrafts(t, job);
    const disabled = t.literatureBusy || t.busy || job.status === 'running';
    const tableHead = node('div', undefined, 'literature-confirm-actions literature-fields-next');
    tableHead.append(node('h3', '本次提取表格 · ' + drafts.length + ' 个字段'));
    const nextButton = () => {
      const confirm = node('button', t.literatureBusy ? '提交中…' : '核对表格并开始提取', 'primary-button');
      confirm.type = 'button'; confirm.disabled = disabled || !!t.literatureFieldsAssistBusy || !!literatureFieldsAssistState(mod, job).pending || !drafts.length || !!root.LiteratureUI?.isBusy();
      confirm.onclick = () => confirmLiteratureFields(mod); return confirm;
    };
    if (awaitingConfirm) tableHead.append(nextButton());
    box.append(tableHead);
    if (awaitingConfirm) box.append(node('p', job.segmentTask
      ? '下一步：只处理本次选定的 ' + job.segmentTask.paperIds.length + ' 篇，按本表提取已有材料，运行到“' + literatureStageLabel(job.segmentTask.until) + '”后停止。原任务保留。'
      : '下一步：按本表提取原任务的已保存材料，完成提取后停止。缺失材料和待确认问题会保留标记。', 'codex-status'));
    if (!drafts.length) box.append(node('p', '还没有提取字段，点击“新增提取字段”开始填写。', 'codex-status'));
    const notice = node('p', t.literatureFieldsError || '草稿自动保存在本浏览器，保存草稿不会启动提取。', t.literatureFieldsError ? 'codex-error' : 'codex-status');
    notice.setAttribute('aria-live', 'polite');
    const saveDraft = () => {
      saveLiteratureFieldDrafts(t, job);
      t.literatureFieldsPreviewRefresh?.();
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
      const conditionWrap = node('label', '每条数值需关联的条件（可选）');
      conditionWrap.setAttribute('style', 'grid-column: 1 / -1; grid-row: 2;');
      const conditionInput = node('input'); conditionInput.type = 'text'; conditionInput.maxLength = 3200;
      conditionInput.setAttribute('aria-label', '第' + (index + 1) + '个字段关联条件键');
      conditionInput.placeholder = '如指标、处理组、时间点，用逗号分隔（先讨论确认）';
      conditionInput.value = Array.isArray(draft.conditionKeys) ? draft.conditionKeys.join(', ') : String(draft.conditionKeys || '');
      conditionInput.disabled = disabled;
      conditionInput.oninput = () => { draft.conditionKeys = conditionInput.value.split(/[,，]/).map(key => key.trim()).filter(Boolean); saveDraft(); };
      conditionWrap.append(conditionInput); cell.append(conditionWrap);
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
    box.append(node('p', '先讨论确认每条数值需关联哪些条件，如指标、处理组、时间点，再用逗号分隔填写。目前各行填写的条件会合并用于本次所有数值；不确定时先留空，不会自动补造。', 'codex-status'), fields);
    const actions = node('div', undefined, 'literature-confirm-actions');
    const add = node('button', '新增提取字段', 'quiet-button'); add.type = 'button'; add.disabled = disabled || drafts.length >= 200;
    add.onclick = () => addLiteratureField(mod, t, job); actions.append(add);
    if (awaitingConfirm) {
      actions.append(nextButton());
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
          : job.processingBasis ? literatureProcessingBasisMessage(job) : literatureStatusText(job);
        const historyNote = node('span', job.processingBasis ? historyMessage : historyMessage.slice(0, 60), 'literature-history-message');
        historyNote.title = historyMessage; row.append(historyNote);
        if (job.deletedAt) {
          const restore = node('button', '恢复', 'quiet-button'); restore.type = 'button';
          restore.disabled = !!t.literatureHistoryBusy || t.literatureJobsLoading;
          restore.onclick = () => changeLiteratureHistory(mod, job, true); row.append(restore);
        } else {
          const open = node('button', '查看', 'quiet-button'); open.type = 'button'; open.title = '只读查看这次任务的最新状态和已保存文件，不切换当前工作区';
          open.onclick = () => openLiteratureHistoryDetails(mod, job);
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
  function literatureReaderSize() {
    if (Number.isFinite(literatureReaderSize.value)) return literatureReaderSize.value;
    try {
      const value = Number(localStorage.getItem('research_literature_reader_size_v1'));
      return value >= 18 && value <= 28 ? value : 20;
    } catch (_) { return 20; }
  }
  function literatureReaderControls() {
    const size = literatureReaderSize();
    document.documentElement?.style?.setProperty('--literature-reader-size', size + 'px');
    const controls = node('div', undefined, 'literature-reader-controls');
    controls.setAttribute('aria-label', '文献区文字大小');
    controls.append(node('span', '字号'));
    const value = node('span', size + ' px'); value.setAttribute('aria-live', 'polite');
    [-2, 2].forEach(delta => {
      const button = node('button', delta < 0 ? 'A−' : 'A＋', 'quiet-button'); button.type = 'button';
      button.setAttribute('aria-label', delta < 0 ? '缩小文献文字' : '放大文献文字');
      button.disabled = delta < 0 ? size <= 18 : size >= 28;
      button.onclick = () => {
        const next = Math.max(18, Math.min(28, size + delta));
        literatureReaderSize.value = next;
        try { localStorage.setItem('research_literature_reader_size_v1', String(next)); } catch (_) {}
        document.documentElement?.style?.setProperty('--literature-reader-size', next + 'px');
        render();
      };
      if (delta < 0) controls.append(button, value); else controls.append(button);
    });
    return controls;
  }
  function compactLiteraturePanel(mod, t, box) {
    if (!box.children || typeof box.replaceChildren !== 'function') return;
    const children = Array.from(box.children), job = t.literatureJob;
    const hasClass = (element, name) => String(element.className || '').split(/\s+/).includes(name);
    const retained = [], operations = [], process = [], finalFiles = [], notices = [], attention = [];
    children.forEach(child => {
      if (hasClass(child, 'literature-overview') || hasClass(child, 'literature-task-selector')) retained.push(child);
      else if (hasClass(child, 'literature-deliverables')) {
        Array.from(child.children).forEach(section => {
          if (hasClass(section, 'literature-deliverable-export')) finalFiles.push(section);
          else if (hasClass(section, 'literature-deliverable-notice')) notices.push(section);
          else process.push(section);
        });
      } else if (hasClass(child, 'literature-material-skipped')) attention.push(child);
      else if (hasClass(child, 'literature-history') || (child.tagName === 'DETAILS' && !hasClass(child, 'literature-config') && !hasClass(child, 'literature-guidance'))) process.push(child);
      else if (hasClass(child, 'literature-confirm') || hasClass(child, 'codex-error')) attention.push(child);
      else operations.push(child);
    });
    const pieces = [];
    if (job) {
      const state = literatureJobStatusLabel(job);
      pieces.push((job.until ? literatureStageLabel(job.until) + ' · ' : '') + state);
      const counters = job.counters || {};
      const exported = job.status === 'completed' && job.files?.some(name => /^export\/literature\.(xlsx|csv)$/.test(name));
      const records = Number.isSafeInteger(counters.uniqueGroups) ? counters.uniqueGroups : counters.candidates;
      if (exported && Number.isSafeInteger(records)) pieces.push('文献表 ' + records + ' 条文献记录');
      else if (Number.isSafeInteger(counters.candidates)) pieces.push('候选 ' + counters.candidates);
      if (Number.isSafeInteger(counters.fulltextFetched)) pieces.push('已获取正文 ' + counters.fulltextFetched + ' 篇');
      if (Number.isSafeInteger(counters.fulltextPdf)) pieces.push('PDF ' + counters.fulltextPdf + ' 篇');
      if (Number.isSafeInteger(counters.fulltextHtml)) pieces.push('网页正文 ' + counters.fulltextHtml + ' 篇');
      if (Number.isSafeInteger(counters.parameterRows)) pieces.push('参数记录 ' + counters.parameterRows + ' 行');
    } else pieces.push('尚未检索 · 先讨论需求并核对设置');
    const summary = node('p', pieces.join('　·　'), 'literature-task-summary');
    summary.setAttribute('aria-live', 'polite');
    let contextId = '';
    try { if (typeof literatureWorkspaceManager === 'function') contextId = literatureWorkspaceManager(mod)?.active()?.id || ''; } catch (_) {}
    const key = [mod.id, contextId, job?.id || 'draft'].join(':');
    const states = compactLiteraturePanel.disclosureState || (compactLiteraturePanel.disclosureState = new Map());
    function disclosure(name, className, suffix, initial) {
      const element = node('details', undefined, className), stateKey = key + ':' + suffix;
      element.open = states.has(stateKey) ? states.get(stateKey) : initial;
      const heading = node('summary', name);
      // Initial open also emits toggle; only an explicit click records a preference.
      heading.onclick = event => { if (!event?.defaultPrevented) states.set(stateKey, !element.open); };
      element.append(heading); return element;
    }
    const settings = disclosure('检索与执行设置（展开操作）', 'literature-workspace-section', 'operations', !job);
    operations.forEach(child => settings.append(child));
    const fileCount = Array.isArray(job?.files) ? job.files.filter(name => !String(name).startsWith('export/')).length : 0;
    const files = disclosure('材料、过程文件与历史记录' + (fileCount ? ' · ' + fileCount + ' 个文件' : ''), 'literature-process-files', 'files', false);
    process.forEach(child => files.append(child));
    box.replaceChildren(...retained, summary);
    // A running task always keeps its stop action visible, even with settings closed.
    if (job?.status === 'running') {
      const toolbar = operations.find(child => hasClass(child, 'literature-toolbar'));
      const stop = toolbar && Array.from(toolbar.children).find(child => child.tagName === 'BUTTON' && child.textContent === '停止');
      if (stop) box.append(stop);
    }
    attention.forEach(child => box.append(child));
    const body = disclosure('任务详情与全部成果（点击展开 / 收起）', 'literature-panel-body', 'all', !job || ['running', 'needs_attention'].includes(job.status));
    if (notices.length) {
      const short = node('div', undefined, 'literature-compact-warning');
      const missing = job?.counters?.materialsIncomplete;
      short.append(node('span', Number.isFinite(missing) && missing > 0 ? '材料仍有缺口 ' + missing + ' 篇；结果需回原件核查。' : '结果需回原件核查。'));
      notices.forEach(child => {
        const source = child.querySelector?.('a');
        if (source) {
          const link = node('a', source.textContent, 'literature-warning-link'); link.href = source.href; short.append(link);
        }
      });
      box.append(short);
      const warnings = node('div', undefined, 'literature-compact-notices');
      notices.forEach(child => warnings.append(child)); body.append(warnings);
    }
    if (finalFiles.length) {
      const quick = node('div', undefined, 'literature-primary-downloads');
      [['parameters', '参数明细表'], ['literature', '文献表']].forEach(([stem, label]) => {
        const name = ['export/' + stem + '.xlsx', 'export/' + stem + '.csv'].find(candidate => job.files.includes(candidate));
        if (!name) return;
        const link = node('a', label + (name.endsWith('.xlsx') ? ' Excel' : ' CSV'), 'quiet-button');
        link.href = '/api/literature/download?id=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(name); quick.append(link);
      });
      if (quick.children.length) box.append(quick);
      const exports = node('div', undefined, 'literature-deliverables literature-main-results');
      finalFiles.forEach(child => exports.append(child)); body.append(exports);
    }
    body.append(settings, files); box.append(body);
    // Keep native history/log disclosures open during the same job's polling updates.
    Array.from(box.querySelectorAll?.('details') || []).forEach(details => {
      const heading = Array.from(details.children).find(child => child.tagName === 'SUMMARY');
      if (!heading || typeof heading.onclick === 'function') return;
      const stateKey = key + ':native:' + (details.className || heading.textContent.split(' · ')[0]);
      if (states.has(stateKey)) details.open = states.get(stateKey);
      heading.onclick = event => { if (!event?.defaultPrevented) states.set(stateKey, !details.open); };
    });
  }
  function literaturePanel(mod, t, container = panel) {
    const box = node('div', undefined, 'literature-connector');
    const scholarTrial = (t.literatureJob?.config || t.literatureConfig)?.scholarPlan?.trialMaxPages != null;
    let timeoutAttention = null;
    const overview = node('div', undefined, 'literature-overview');
    const introduction = node('div');
    introduction.append(node('h3', '文献任务'));
    const help = node('button', '使用说明', 'quiet-button'); help.type = 'button';
    help.onclick = () => document.dispatchEvent(new CustomEvent('literature-help-open'));
    overview.append(introduction, help); box.append(overview);
    if (root.LiteratureConfirmedPlan) {
      const confirmed = node('button', '载入五库已确认方案', 'primary-button'); confirmed.type = 'button';
      confirmed.disabled = literatureWorkspaceBusy(mod.id);
      confirmed.onclick = () => root.LiteratureConfirmedPlan.open({
        onPrepared: job => {
          const manager = literatureWorkspaceManager(mod);
          if (!manager) throw new Error('当前文献工作区尚未就绪');
          const result = manager.create({ name: job.config.topic.slice(0, 80), mode: 'formal',
            seedClient: { backend: task(mod.id).backend, model: task(mod.id).model, literatureJobId: job.id,
              literatureConfig: JSON.parse(JSON.stringify(job.config)), literatureUntil: 'discover', literatureConfigOpen: false } });
          if (!result.ok) throw new Error(result.error);
          attachLiteratureJob(mod, job); root.ModuleSpace?.render();
        }
      });
      overview.append(confirmed);
      if (t.literatureJob?.config?.screeningPolicy) {
        const screening = node('button', '筛选记录与待定全文', 'quiet-button'); screening.type = 'button';
        screening.disabled = literatureWorkspaceBusy(mod.id);
        screening.onclick = () => root.LiteratureConfirmedPlan.open({ job: t.literatureJob });
        overview.append(screening);
      }
    }
    if (typeof literatureReaderControls === 'function') overview.append(literatureReaderControls());
    if (typeof literatureTaskSelector === 'function') {
      const selector = literatureTaskSelector(mod, t);
      if (selector) box.append(selector);
    }
    const row = node('div', undefined, 'codex-toolbar literature-toolbar');
    const readOnlyResults = !!t.literatureJob?.id && saved[mod.id]?.literatureReadOnlyJobId === t.literatureJob.id;
    const segment = t.literatureJob?.segmentTask;
    const preparePending = t.literaturePreparePending || saved[mod.id]?.literaturePreparePending;
    const prepareEnded = ['failed', 'unavailable', 'invalid_result', 'basis_changed'].includes(preparePending?.status);
    const prepare = node('button', t.literatureBusy ? '处理中…' : prepareEnded ? '本次整理已结束' : preparePending?.id ? '检查整理进度' : preparePending ? '整理受理状态未知' : '从对话更新规则并核查', 'quiet-button');
    prepare.type = 'button'; prepare.disabled = readOnlyResults || t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || prepareEnded || !!preparePending && !preparePending.id;
    prepare.onclick = () => prepareLiteratureAndReview(mod); if (!segment) row.append(prepare);
    if (!segment && preparePending) {
      const recovery = node('section', undefined, 'literature-confirm literature-prepare-recovery');
      recovery.append(node('h4', prepareEnded ? '本次规则整理未应用' : preparePending.id ? '规则整理进度已保留' : '规则整理受理状态未知'));
      recovery.append(node('p', '本次整理结果尚未写入。下方显示原草稿，不能据此认为本轮新检索式已经生效。', 'codex-status'));
      recovery.append(node('p', prepareEnded
        ? literaturePrepareFailure('本次规则整理', new Error(preparePending.error || '运行记录无法恢复，或整理依据已变化。')) + ' 不会继续反复读取或自动提交。'
        : preparePending.id
        ? '同一次整理编号：' + preparePending.id + '。刷新或断线后点击“检查整理进度”只读取该任务，不会重新提交或启动文献检索。'
        : '未收到运行编号，不能确定后台是否已受理。原草稿和确认记录保留；不会自动重发。', 'codex-status'));
      if (!prepareEnded) {
        const checkPrepare = node('button', preparePending.id ? '检查整理进度' : '检查本地连接', 'quiet-button'); checkPrepare.type = 'button';
        checkPrepare.disabled = t.literatureBusy || t.busy; checkPrepare.onclick = () => preparePending.id ? checkLiteraturePrepareProgress(mod) : checkLiteraturePrepareConnection(mod); recovery.append(checkPrepare);
      }
      if (preparePending.status === 'invalid_result' && preparePending.id) {
        const reread = node('button', '重新读取这次整理结果', 'quiet-button'); reread.type = 'button';
        reread.disabled = readOnlyResults || t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        reread.onclick = () => prepareLiteratureAndReview(mod, { retryResult: true });
        recovery.append(reread, node('p', '重新读取已收到的回复，不再次调用AI。原回复已不存在时会明确提示；只有点击“结束本次并重新整理”才会生成新的回复。', 'codex-status'));
      }
      recovery.append(node('p', '“放弃本次等待”只结束页面等待，不停止可能已受理的后台整理，也不修改原草稿或确认。放弃后，再次点击“从对话更新规则并核查”才会新提交。', 'codex-status'));
      const abandon = node('button', '放弃本次等待', 'quiet-button'); abandon.type = 'button'; abandon.disabled = t.literatureBusy || t.busy;
      abandon.onclick = () => endLiteraturePreparation(mod); recovery.append(abandon);
      if (prepareEnded) {
        recovery.append(node('p', '“结束本次并重新整理”会清除这次页面等待，按当前对话新提交一次规则整理；不会启动文献检索，原草稿和确认在新草稿生成前保留。', 'codex-status'));
        const retryPrepare = node('button', '结束本次并重新整理', 'quiet-button'); retryPrepare.type = 'button';
        retryPrepare.disabled = readOnlyResults || t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        retryPrepare.onclick = () => { if (endLiteraturePreparation(mod)) return prepareLiteratureAndReview(mod); }; recovery.append(retryPrepare);
      }
      box.append(recovery);
    }
    if (!t.literatureConfig && !segment) {
      const manual = node('button', '手动填写', 'quiet-button'); manual.type = 'button'; manual.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      manual.onclick = () => manualLiterature(mod); row.append(manual);
    }
    const job = t.literatureJob;
    if (job?.config?.researchPlan) {
      const handoff = node('section', undefined, 'literature-confirm');
      handoff.append(node('h4', '此库已确认方案'), node('p', '检索式与篇关摘规则已绑定。按库分阶段处理；每批导入累计保存，导入完成不等于已覆盖全部检索结果。', 'codex-status'));
      const queryDetails = node('details'); queryDetails.append(node('summary', '查看本次实际检索式与筛选规则'));
      const queryText = job.config.scholarPlan?.topics?.map(topic => topic.id + ' · ' + topic.query).join('\n\n') || job.config.query;
      const pre = node('pre', queryText); pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; pre.style.maxHeight = '260px'; pre.style.overflow = 'auto';
      queryDetails.append(pre, node('p', '筛选版本：' + job.config.screeningPolicy.id));
      const policy = node('pre', job.config.screeningPolicy.text); policy.style.whiteSpace = 'pre-wrap'; policy.style.maxHeight = '240px'; policy.style.overflow = 'auto'; queryDetails.append(policy);
      handoff.append(queryDetails);
      const copyQuery = node('button', '复制本次检索式', 'quiet-button'); copyQuery.type = 'button';
      copyQuery.onclick = async () => { try { await navigator.clipboard.writeText(queryText); copyQuery.textContent = '已复制'; } catch (_) { copyQuery.textContent = '请展开上方检索式手动复制'; } }; handoff.append(copyQuery);
      const file = node('input'); file.type = 'file'; file.accept = '.ris,.bib,.bibtex,.csv,.tsv,.txt'; file.hidden = true;
      const importButton = node('button', '导入此库题录（可分批）', 'quiet-button'); importButton.type = 'button';
      importButton.disabled = readOnlyResults || literatureWorkspaceBusy(mod.id) || job.stages?.extract === 'done';
      importButton.onclick = () => file.click();
      file.onchange = async () => {
        const selected = file.files?.[0]; if (!selected) return;
        if (selected.size > 3 * 1024 * 1024) { t.literatureError = '请将题录按不超过3MB的批次导入；已导入批次会保留。'; render(); return; }
        t.literatureBusy = true; t.literatureError = ''; importButton.disabled = true;
        try {
          const content = await selected.text();
          await request('/api/literature/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, source: job.config.sources[0], filename: selected.name, content }) });
          const fresh = await request('/api/literature/job?id=' + encodeURIComponent(job.id)); applyLiteratureJob(mod, fresh);
          t.literatureUntil = 'fulltext'; saved[mod.id] = { ...saved[mod.id], literatureUntil: 'fulltext' }; persist();
        } catch (error) { t.literatureError = error.message; }
        finally { t.literatureBusy = false; render(); }
      };
      handoff.append(importButton, file, node('p', '可导入RIS、BibTeX、CSV或TSV，请在数据库导出时包含摘要、关键词和DOI。缺失信息会保留为待定。', 'codex-status'));
      if (job.config.sources.some(source => ['cnki', 'web-of-science', 'scopus', 'wanfang'].includes(source))) handoff.append(node('p', '完整字段式需要数据库高级／专业检索入口。平台只在能核对该入口和实际检索条件时继续；无法识别时会停下，也可在原库检索后导出题录到这里累计导入。', 'codex-status'));
      box.append(handoff);
    }
    if (!segment && !job?.config?.researchPlan && (job?.id || saved[mod.id]?.literatureJobId)) {
      const frozen = node('section', undefined, 'literature-confirm literature-frozen-review');
      frozen.append(node('h4', '本次任务的已确认配置'), node('p', '查看启动时保存的逐项核查记录。该记录只读，不修改当前设置或继续运行任务。', 'codex-status'));
      const viewConfirmed = node('button', '查看已确认配置', 'quiet-button'); viewConfirmed.type = 'button';
      viewConfirmed.onclick = () => openLiteratureRuleReview(mod); frozen.append(viewConfirmed); box.append(frozen);
      if (job?.id && !readOnlyResults && !job.materialReplenishment?.parentJobId) {
        const fromHistory = saved[mod.id]?.literatureHistoryLoadedJobId === job.id || t.literatureRevisionNeedsHistoryImport === true
          || /原任务规则快照不属于当前文献(?:会话|任务|工作区)/.test(t.literatureError || '');
        const revise = node('button', fromHistory ? '从历史配置建立修改草稿' : '修改配置并继续', 'primary-button'); revise.type = 'button';
        revise.disabled = t.busy || t.literatureBusy || job.status === 'running' || !!job.deletedAt || !!root.LiteratureUI?.isBusy() || !!root.ModuleSpace?.isBusy();
        revise.title = fromHistory ? '将历史配置显式导入当前文献工作区，保留当前讨论和最新草稿；重新核查后才会建立新任务。'
          : '从本任务冻结配置建立修订草稿。确认后用新配置开始新任务，原结果和任务保留，不复用旧断点。';
        revise.onclick = () => reviseLiteratureConfiguration(mod, { fromHistory }); frozen.append(revise);
        if (t.literatureConfig) {
          const latestDraft = node('section', undefined, 'literature-confirm literature-review-draft-entry');
          latestDraft.append(node('h4', '当前规则草稿'), node('p', saved[mod.id]?.literatureSource !== literatureSource(mod)
            ? '讨论已更新，但尚未成功整理进当前草稿；核查页显示已有实际值，不表示新检索式已经写入。可先继续整理或核对。'
            : '直接核查当前草稿的实际检索式；旧任务及其冻结记录保留，不会先复制旧配置，也不会开始检索。', 'codex-status'));
          const checkDraft = node('button', '继续逐项核查', 'primary-button'); checkDraft.type = 'button'; checkDraft.disabled = t.busy || t.literatureBusy || !!root.LiteratureUI?.isBusy();
          checkDraft.title = '直接打开当前规则草稿；旧运行的冻结配置仍可单独只读查看。';
          checkDraft.onclick = () => openLiteratureRuleReview(mod, { draft: true }); latestDraft.append(checkDraft); box.append(latestDraft);
        }
      }
      if (saved[mod.id]?.literatureRevisionDraft) {
        const draft = node('button', saved[mod.id].literatureRevisionDraft.job?.id ? '回到修改后的任务' : '回到修改草稿', 'quiet-button'); draft.type = 'button';
        draft.disabled = t.busy || t.literatureBusy || job?.status === 'running'; draft.onclick = () => swapLiteratureRevision(mod, false); frozen.append(draft);
      }
      if (saved[mod.id]?.literatureRevisionOriginal) {
        const back = node('button', '返回原任务', 'quiet-button'); back.type = 'button';
        back.disabled = t.busy || t.literatureBusy || job?.status === 'running'; back.onclick = () => swapLiteratureRevision(mod, true); frozen.append(back);
      }
    }
    if (!segment && !job?.id && !saved[mod.id]?.literatureJobId && saved[mod.id]?.literatureRevisionParentId) {
      const revision = node('section', undefined, 'literature-confirm literature-revision-draft');
      revision.append(node('h4', '修改配置草稿'), node('p', '来源任务 ' + saved[mod.id].literatureRevisionParentId.slice(0, 8)
        + '。确认后按新配置建立新的检索任务；原任务和已有结果保留，不复用旧断点。', 'codex-status'));
      const back = node('button', '返回原任务', 'quiet-button'); back.type = 'button'; back.disabled = t.busy || t.literatureBusy;
      back.onclick = () => swapLiteratureRevision(mod, true); revision.append(back); box.append(revision);
    }
    const replenishing = !!job?.materialReplenishment?.parentJobId;
    if (job?.id && job.files?.some(name => /^(?:fulltext|extraction|validation|export)\//.test(name))) {
      const entry = node('section', undefined, 'literature-confirm literature-segment-entry');
      const fromExisting = node('button', '从已有成果开始', 'quiet-button'); fromExisting.type = 'button';
      fromExisting.disabled = t.literatureBusy || t.busy || job.status === 'running' || !!job.deletedAt || !!root.LiteratureUI?.isBusy();
      fromExisting.title = '自由选择文献和提取、校验、导出范围，创建独立暂停任务；原成果保留。';
      fromExisting.onclick = () => openLiteratureSegmentDialog(mod); entry.append(fromExisting);
      entry.append(node('span', ' 选择文献与执行范围，建立独立暂停任务。', 'codex-status')); box.append(entry);
    }
    if (segment) box.append(literatureSegmentSummary(mod, t, job, readOnlyResults));
    const relatedChildId = job?.id && saved[mod.id]?.literatureMaterialsParentId === job.id ? saved[mod.id]?.literatureMaterialsChildId : null;
    if (job?.canReplenishMaterials === true || replenishing || relatedChildId) {
      const materialsAction = node('section', undefined, 'literature-confirm literature-replenishment');
      const candidateCount = replenishing ? job.materialReplenishment.candidateCount : job.counters?.candidates ?? job.count;
      materialsAction.append(node('p', '沿用原' + (Number.isSafeInteger(candidateCount) ? candidateCount : '待核对的')
        + '篇候选；仅补材料；原提取和导出结果保留。', 'codex-status'));
      const actions = node('div', undefined, 'literature-confirm-actions');
      if (job.canReplenishMaterials === true && !readOnlyResults) {
        const replenish = node('button', '补齐PDF和补充材料', 'primary-button'); replenish.type = 'button';
        replenish.disabled = t.busy || t.literatureBusy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
        replenish.title = '按原任务冻结候选建立独立材料补齐任务；不重新检索、不重做提取或导出。';
        replenish.onclick = () => replenishLiteratureMaterials(mod); actions.append(replenish);
      }
      if (replenishing) {
        const original = node('button', '查看原提取和导出结果', 'quiet-button'); original.type = 'button';
        original.disabled = t.busy || t.literatureBusy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
        original.onclick = () => viewLiteratureMaterialsRelatedJob(mod, job.materialReplenishment.parentJobId); actions.append(original);
      } else if (relatedChildId) {
        materialsAction.append(node('p', '当前只读查看原提取和导出结果。', 'codex-status'));
        const child = node('button', '查看材料补齐任务', 'quiet-button'); child.type = 'button';
        child.disabled = t.busy || t.literatureBusy || !!root.LiteratureUI?.isBusy();
        child.onclick = () => viewLiteratureMaterialsRelatedJob(mod, relatedChildId); actions.append(child);
      }
      materialsAction.append(actions); box.append(materialsAction);
    }
    const awaitingConfirm = !!job && ((job.status === 'needs_attention' && job.stage === 'awaiting_confirmation')
      || (job.status === 'cancelled' && segment?.fromStage === 'extract' && segment.fieldsConfirmed !== true));
    const awaitingAccess = !!job && job.status === 'needs_attention' && !awaitingConfirm && job.stage !== 'awaiting_segment_confirmation';
    const awaitingStart = awaitingAccess && job.stage === 'prepared';
    const sameConfig = !t.literatureConfig || !job?.config || sameLiteratureConfig(job.config, t.literatureConfig);
    if (!segment && !job?.id && !saved[mod.id]?.literatureJobId && t.literatureConfig) {
      const review = t.literatureRuleReview;
      const reviewEntry = node('section', undefined, 'literature-confirm literature-review-draft-entry');
      reviewEntry.append(node('h4', saved[mod.id]?.literatureRevisionParentId ? '修改配置草稿 · 继续核查' : '本次规则草稿 · 逐项核查'));
      const reviewButton = node('button', review?.id ? '继续逐项核查' : '开始逐项核查', 'quiet-button'); reviewButton.type = 'button';
      reviewButton.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      reviewButton.onclick = () => openLiteratureRuleReview(mod); reviewEntry.append(reviewButton);
      if (review?.id) {
        let currentReview = false;
        try { currentReview = root.LiteratureRuleReview?.matches(review, effectiveLiteratureReviewConfig(t), t.literatureUntil || 'discover', literatureSource(mod)); } catch (_) {}
        reviewEntry.append(node('span', t.literatureReviewNeedsSync ? '新草稿待同步核查 · 原确认历史保留'
          : currentReview && saved[mod.id]?.literatureReviewAppliedRevision === review.revision
            ? '逐项核查已确认并应用' : '已确认 ' + (review.progress?.confirmed ?? 0) + '/' + (review.progress?.total ?? review.items?.length ?? 14) + ' · 修改配置后需核对受影响项', 'codex-status'));
      }
      else if (t.literatureReviewNeedsSync) reviewEntry.append(node('span', '新草稿待逐项核查', 'codex-status'));
      box.append(reviewEntry);
    }
    const start = node('button', saved[mod.id]?.literatureRevisionParentId && !job?.id ? '按修改后的配置开始'
      : t.literatureRuleReview?.ready ? '按已确认配置检索' : '确认配置并检索', 'primary-button');
    start.type = 'button'; start.disabled = t.literatureBusy || !!root.LiteratureUI?.isBusy() || t.busy || !t.literatureConfig || !!preparePending || !!job?.id || !!saved[mod.id]?.literatureJobId || (awaitingAccess && sameConfig);
    if (preparePending) start.title = '本次规则整理尚未应用；先读取整理结果或结束后重新整理，再核查新草稿。';
    if (job?.id || saved[mod.id]?.literatureJobId) start.title = '本任务已有检索记录；正式检索或其他主题请先点击“新建文献任务”。';
    if (awaitingAccess && sameConfig) start.title = '原任务等待人工处理；请用下方“检查并继续”，保留已有来源的结果。';
    if (awaitingStart && sameConfig) start.title = '此库任务已准备，请用下方“开始检索”，无需重建任务。';
    if (awaitingConfirm) start.title = '当前任务停在字段确认关口；本按钮发起一次新检索，继续原任务请在字段表格点击“核对表格并开始提取”。';
    start.onclick = () => startLiterature(mod); if (!segment) row.append(start);
    if (job && (job.status === 'running' || (!segment && job.status === 'needs_attention'))) {
      const stop = node('button', '停止', 'quiet-button'); stop.type = 'button';
      stop.onclick = async () => {
        try { t.literatureJob = await request('/api/literature/cancel?id=' + encodeURIComponent(t.literatureJob.id), { method: 'POST' }); }
        catch (error) { t.literatureError = error.message; }
        render();
      };
      row.append(stop);
    }
    const effectiveResumeStage = literatureResumeStage(job);
    const canAdvance = !!job && !!effectiveResumeStage && ['completed', 'failed', 'needs_attention'].includes(job.status)
      && job.status !== 'needs_attention' && !(scholarTrial && job.status === 'completed');
    if (canAdvance && !readOnlyResults && !job.cnkiRetryPaperId) {
      const label = job.status === 'completed' ? '继续下一阶段' : job.status === 'failed' ? (job.stage === 'interrupted' ? '继续中断的任务' : '重试当前阶段') : '继续';
      const advance = node('button', label, job.status === 'completed' ? 'primary-button' : 'quiet-button'); advance.type = 'button'; advance.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      advance.title = segment ? '继续本次已固定的执行范围，复用前置成果。' : '继续原任务，运行到上方所选阶段；请先选择下一阶段或更后的目标。';
      advance.onclick = () => continueLiterature(mod); row.append(advance);
    }
    if (segment && job.status === 'cancelled' && effectiveResumeStage && !readOnlyResults) {
      const needsFields = segment.fromStage === 'extract' && segment.fieldsConfirmed !== true;
      const resumeSegment = node('button', needsFields ? '核对表头后继续' : '继续本次执行范围', 'primary-button'); resumeSegment.type = 'button';
      resumeSegment.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      resumeSegment.title = '沿用本次选定文献、已确认字段与结束阶段；逐篇完成的成果保留。';
      resumeSegment.onclick = () => needsFields ? openLiteratureFields(mod)
        : continueLiterature(mod, { until: segment.until, ...(segment.schemaLocked ? { confirmSegment: true } : {}) }); row.append(resumeSegment);
    }
    if (job?.status === 'cancelled' && job.config?.researchPlan && effectiveResumeStage && !readOnlyResults && !segment) {
      const resume = node('button', '从已保存断点继续', 'primary-button'); resume.type = 'button';
      resume.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      resume.title = '沿用原检索式和筛选规则，复用已完成记录；不会自动跳过失败项。';
      resume.onclick = () => continueLiterature(mod, { until: job.until || effectiveResumeStage, resumeConfirmed: true }); row.append(resume);
    }
    if (job?.status === 'cancelled' && !job.config?.researchPlan && job.resumeStage === 'fulltext' && !readOnlyResults && !job.cnkiRetryPaperId) {
      const stopped = node('button', '按原任务继续（跳过失败项）', 'primary-button'); stopped.type = 'button';
      stopped.title = '恢复原任务冻结设置与已有候选，保留已存材料，跳过无法取得的正文或补材；只运行到全文获取。';
      stopped.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
      stopped.onclick = () => continueLiterature(mod, { until: 'fulltext', skipUnavailable: true, resumeStopped: true });
      row.append(stopped);
    }
    if (job?.id) {
      const materials = node('button', '每篇材料清单', 'quiet-button'); materials.type = 'button';
      materials.title = '只读查看正文PDF、网页正文和补充材料的保存与读取状态，不运行任务。';
      materials.onclick = () => openLiteratureMaterials(mod); row.append(materials);
      if (job.canReviewFulltext === true && !readOnlyResults && !replenishing && !segment) {
        const review = node('button', '复核已保存全文', 'quiet-button'); review.type = 'button';
        review.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        review.title = '仅离线复核缓存，保留原文件和备份；不打开网页、不重新检索或下载。';
        review.onclick = () => reviewLiteratureFulltext(mod); row.append(review);
      }
      const editFields = node('button', '设置提取字段', 'quiet-button'); editFields.type = 'button'; editFields.hidden = readOnlyResults || replenishing || !!segment?.schemaLocked;
      editFields.disabled = t.literatureBusy || t.busy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
      editFields.onclick = () => openLiteratureFields(mod); row.append(editFields);
    }
    const untilWrap = node('label', '本次做到哪一步');
    const until = node('select'); until.setAttribute('aria-label', '本次运行到');
    (scholarTrial ? [['discover', '仅检索候选（预试不获取全文）']] : replenishing ? [['fulltext', '仅补齐全文与补充材料']] : LITERATURE_UNTIL_OPTIONS).forEach(([value, title]) => { const option = node('option', value === 'fulltext' && job?.config?.screeningPolicy ? '篇关摘筛选并获取全文' : title); option.value = value; until.append(option); });
    until.value = scholarTrial ? 'discover' : replenishing ? 'fulltext' : t.literatureUntil || 'discover'; until.disabled = scholarTrial || replenishing || readOnlyResults || t.literatureBusy || t.busy;
    until.onchange = () => { t.literatureUntil = until.value; saved[mod.id] = { ...saved[mod.id], literatureUntil: t.literatureUntil }; persist(); render(); };
    untilWrap.append(until); if (!segment) row.append(untilWrap);
    box.append(row);
    const flowNotes = node('details', undefined, 'literature-deliverable-group');
    flowNotes.append(node('summary', '流程与登录说明（点击展开）'));
    flowNotes.append(node('p', '讨论需求 → 确认设置 → 执行 → 核查结果', 'codex-status'));
    flowNotes.append(node('p', '候选检索固定为五库：' + Object.values(LITERATURE_SOURCE_LABELS).join(' / ') + '；按研究需要勾选，不是每次都全选。', 'codex-status'));
    flowNotes.append(node('p', '登录流程：需要登录、验证或机构权限时，平台会尝试自动打开本任务的官方页面。请在平台专用检索浏览器操作，它会保存该浏览器的登录状态；普通 Edge/Chrome 的登录不会自动共享。完成后回到本平台点击“检查并继续”，任务才会恢复。', 'codex-status'));
    flowNotes.append(node('p', '全文页面按加载、生成和传输进展等待，确认就绪后取材；长时间没有新进展或达到活动保护上限时，保留尚未就绪的页面，稍后显式重新检查。人工登录与等待不限时。', 'codex-status'));
    if (job?.files?.includes('fulltext/status.json') || job?.resumeStage === 'fulltext') {
      flowNotes.append(node('p', job.fulltextFailurePolicy === 'skip'
        ? '全文获取逐篇处理：已确认无法取得的正文或补充材料记录原因后跳过，继续下一篇；登录、验证、机构权限或尚未就绪的页面保留再查。文件保存完成后及时关闭，已有材料不重复下载；本地文件校验问题仍需处理。'
        : '全文获取逐篇处理：同篇文献复用任务页，文件保存完成后及时关闭；持续加载、生成或传输时继续等待，尚未就绪的页面保留再查。登录、验证和机构权限保留待处理，明确不可获取的材料记录原因；已有材料不重复下载。', 'codex-status'));
    }
    if (!segment) box.append(flowNotes);
    if (job?.processingBasis) box.append(node('p', literatureProcessingBasisMessage(job), 'codex-status'));
    const executionOrder = job ? Array.isArray(job.executionOrder) ? job.executionOrder : job.config?.sources : newLiteratureSourceOrder(t.literatureConfig?.sources);
    if (!segment && !job?.processingBasis && Array.isArray(executionOrder) && executionOrder.length) box.append(node('p', (job ? '当前任务执行顺序：' : '新检索执行顺序：')
      + executionOrder.map(source => LITERATURE_SOURCE_LABELS[source] || source).join(' → '), 'codex-status'));
    if (job) {
      const deferred = Array.isArray(job.deferredSources) ? [...new Set(job.deferredSources)].filter(source => job.config?.sources?.includes(source)) : [];
      box.append(node('p', '状态：' + (job.deferredOnly === true ? '已暂缓，当前没有其他待检索来源' : deferred.length && job.status === 'completed' ? '仍有暂缓来源待补检，检索尚未全部完成' : literatureStatusText(job) || literatureStageLabel(job.stage) || job.status), 'codex-status'));
      const discoveryProgress = typeof literatureDiscoveryProgress === 'function' ? literatureDiscoveryProgress(job) : null; if (discoveryProgress) box.append(discoveryProgress);
      if (deferred.length) box.append(node('p', '暂缓来源待补检：' + deferred.map(source => LITERATURE_SOURCE_LABELS[source] || source).join('、')
        + '。已有候选保留，检索尚未全部完成；可打开原页面处理后点击“' + (job.deferredOnly === true ? '补检该来源' : '检查并继续') + '”补检。', 'codex-status'));
      const stages = literatureStageBar(job);
      if (stages) box.append(stages);
      if (awaitingConfirm) {
        const fieldsAttention = node('section', undefined, 'literature-confirm'); fieldsAttention.setAttribute('aria-live', 'polite');
        fieldsAttention.append(node('h4', '当前需要处理：确认提取字段'));
        fieldsAttention.append(node('p', '提取字段等待确认：按讨论填入表格，核对名称、含义和单位后，再点击“核对表格并开始提取”。已有候选与材料保留。', 'codex-status'));
        const reviewFields = node('button', '核对提取字段', 'primary-button'); reviewFields.type = 'button';
        reviewFields.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        reviewFields.onclick = () => openLiteratureFields(mod); fieldsAttention.append(reviewFields); box.append(fieldsAttention);
      }
    }
    const manualActions = Array.isArray(job?.materialManualActions) ? job.materialManualActions.filter(item => item.status !== 'skipped'
      && ['login', 'verification', 'access_required', 'page_not_ready'].includes(item.reason)) : [];
    if (replenishing && manualActions.length) {
      const manual = node('section', undefined, 'literature-confirm literature-material-manual');
      manual.setAttribute('aria-live', 'polite');
      manual.append(node('h4', '待处理与待重查文献 · ' + manualActions.length + ' 篇'));
      manual.append(node('p', '原窗口保留，人工等待不限时。逐篇处理登录、验证或权限，或等待页面就绪；点击“我已处理，重新检查待处理文献”后才检查，不会自动重试或重新下载已存PDF。', 'codex-status'));
      const verificationCount = manualActions.filter(item => item.reason === 'verification').length;
      if (verificationCount) manual.append(node('p', verificationCount + ' 篇需要手动完成验证码。请在保留的原页面验证，不会自动反复打开验证页。'
        + (job.status === 'running' ? '本轮继续处理其他文献；你可先完成验证，本轮结束后再点击重新检查。' : '验证完成后，点击“我已处理，重新检查待处理文献”继续。'), 'codex-status'));
      manualActions.forEach(item => {
        const entry = node('div', undefined, 'literature-confirm');
        entry.append(node('h4', String(item.paperId || '文献ID待核对') + ' · ' + String(item.title || '题名待核对')));
        const missing = Array.isArray(item.supplements?.missing) ? item.supplements.missing : [];
        const checkStatus = item.supplements?.checkStatus || item.supplements?.status || 'unknown';
        const checkLabels = { unknown: '尚未检查', checked: '已检查', none_declared: '未声明补充材料', unverified: '尚未核查', complete: '核查完成', partial: '待补充', page_not_ready: '页面尚未就绪，暂未核实' };
        const pending = Array.isArray(item.supplements?.pending) ? item.supplements.pending : [];
        const pdfState = item.mainPdfMissing === true ? '正文PDF待补' : item.mainPdfMissing === false ? '正文PDF已保存' : '正文PDF尚未核实';
        entry.append(node('p', pdfState + '；'
          + '补充材料状态：' + (checkLabels[checkStatus] || checkStatus)
          + (missing.length ? '；待补：' + missing.join('、') : '')
          + (pending.length ? '；待核对附件：' + pending.join('、') : ''), 'codex-status'));
        const reasonLabels = { verification: '需要手动完成验证码', login: '需要登录', access_required: '需要确认机构或订阅权限', page_not_ready: '页面尚未就绪，保留后稍后检查' };
        entry.append(node('p', '原因：' + [reasonLabels[item.reason] || item.reason, item.message].filter(Boolean).join(' · '), 'codex-status'));
        if (item.reason === 'verification') entry.append(node('p', '请在本篇保留的原页面手动完成验证，窗口保留、人工等待不限时；完成后回到这里重新检查。', 'codex-status'));
        const open = node('button', item.reason === 'page_not_ready' ? '查看保留的原页面' : item.reason === 'verification' ? '查看原页面并手动验证' : '打开这篇官方问题页', 'quiet-button'); open.type = 'button';
        open.disabled = !item.paperId || t.busy || t.literatureBusy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
        open.setAttribute('aria-label', '打开官方问题页：' + String(item.paperId || '未知文献'));
        open.onclick = () => openLiteratureMaterialActionPage(mod, item.paperId); entry.append(open); manual.append(entry);
      });
      if (t.literatureMaterialNotice) manual.append(node('p', t.literatureMaterialNotice, 'codex-status'));
      if (job.status !== 'running') {
        const retry = node('button', '我已处理，重新检查待处理文献', 'primary-button'); retry.type = 'button';
        retry.disabled = t.busy || t.literatureBusy || !!root.LiteratureUI?.isBusy();
        retry.onclick = () => continueLiterature(mod, { until: 'fulltext', deferAccess: true, retryDeferred: true }); manual.append(retry);
      }
      box.append(manual);
    }
    if (replenishing && Array.isArray(job.materialSkippedActions) && job.materialSkippedActions.length) {
      const skipped = node('details', undefined, 'literature-deliverable-group literature-material-skipped');
      skipped.append(node('summary', '已跳过材料缺口 · ' + job.materialSkippedActions.length + ' 篇'));
      skipped.append(node('p', '这些记录表示本轮尚未补齐或尚不能确认材料完整，不代表附件不存在。你可点击重新核查；已有正文、PDF和原提取导出结果保留，已保存的文件不会重复下载。不自动重试。', 'codex-status'));
      job.materialSkippedActions.forEach(item => {
        const entry = node('div', undefined, 'literature-confirm');
        entry.append(node('h4', String(item.paperId || '文献ID待核对') + ' · ' + String(item.title || '题名待核对')));
        const missing = Array.isArray(item.supplements?.missing) ? item.supplements.missing : [];
        const checkStatus = item.supplements?.checkStatus || item.supplements?.status || 'unknown';
        const checkLabels = { unknown: '尚未核查', unverified: '尚未核查', needs_attention: '等待人工核查', partial: '尚未齐全', checked: '已检查', none_declared: '未声明补充材料', none_found: '本次未发现补充材料' };
        entry.append(node('p', (item.mainPdfMissing === true ? '正文PDF待补' : item.mainPdfMissing === false ? '正文PDF已保存' : '正文PDF尚未核实')
          + (missing.length ? '；待核查记录：' + missing.join('、') : '；补充材料核查：' + (checkLabels[checkStatus] || checkStatus)), 'codex-status'));
        entry.append(node('p', '原因：' + [item.reason, item.message].filter(Boolean).join(' · '), 'codex-status')); skipped.append(entry);
      });
      const retry = node('button', '重新核查这些材料', 'primary-button'); retry.type = 'button';
      retry.disabled = readOnlyResults || !!job.deletedAt || t.busy || t.literatureBusy || job.status === 'running' || !!root.LiteratureUI?.isBusy();
      retry.title = '仅重新核查本任务已跳过的材料；沿用原候选和已保存文件，不重新检索或进入提取。';
      retry.onclick = () => continueLiterature(mod, { until: 'fulltext', deferAccess: true, retrySkipped: true }); skipped.append(retry);
      const reports = node('div', undefined, 'literature-deliverable-list');
      ['json', 'csv', 'md'].forEach(extension => {
        const name = 'fulltext/skipped-materials.' + extension;
        if (!job.files?.includes(name)) return;
        const link = node('a', LITERATURE_FILE_LABELS[name]);
        link.href = '/api/literature/download?id=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(name); reports.append(link);
      });
      skipped.append(reports); box.append(skipped);
    }
    if (!readOnlyResults && job?.status !== 'running' && !job?.deletedAt && Array.isArray(job?.cnkiRetryItems) && job.cnkiRetryItems.length) {
      const retry = node('details', undefined, 'literature-deliverable-group');
      retry.append(node('summary', '逐篇重试知网全文 · ' + job.cnkiRetryItems.length + ' 篇'));
      retry.append(node('p', '选择一篇，按完整题名进入知网正常检索与详情页，再获取全文。每次只处理这一篇；不会重新检索候选、批量重试其他文献或进入数据提取。', 'codex-status'));
      job.cnkiRetryItems.slice(0, 100).forEach(item => {
        const entry = node('div', undefined, 'literature-confirm');
        entry.append(node('p', item.title)); entry.append(node('p', item.reason, 'codex-status'));
        const button = node('button', item.materials_only ? '继续这篇材料' : job.cnkiRetryPaperId === item.id ? '继续这篇知网文献' : '重试这篇知网文献', 'quiet-button'); button.type = 'button';
        button.setAttribute('aria-label', button.textContent + '：' + item.title);
        button.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || (!!job.cnkiRetryPaperId && job.cnkiRetryPaperId !== item.id);
        button.onclick = () => retryLiteratureCnki(mod, item.id); entry.append(button); retry.append(entry);
        if (job.status === 'failed' && job.cnkiRetryPaperId === item.id && !item.materials_only) {
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
      const deferredMaterials = replenishing && job.attention?.reason === 'deferred_materials';
      const materialsOnly = job.cnkiRetryItems?.some(item => item.id === job.cnkiRetryPaperId && item.materials_only);
      attention.append(node('h4', awaitingStart ? '任务已准备，尚未开始' : job.deferredOnly === true ? '已暂缓，当前没有其他待检索来源' : '当前需要处理：' + (fulltextPaused ? '全文获取' : hasSourcePage ? LITERATURE_SOURCE_LABELS[job.attention.source] : job.resumeStage === 'extract' ? '全文核查与提取确认' : '检索暂停')));
      attention.append(node('p', literatureAttentionMessage(job), 'codex-status'));
      if (replenishing) attention.append(node('p', deferredMaterials
        ? '其他可处理文献已处理。人工等待不限时，窗口保留；请按上方清单处理登录问题或确认页面已就绪，显式重新检查后才继续。'
        : '人工登录与等待不限时，窗口保留。持续加载、生成或传输时继续等待，未就绪的页面保留再查；可先保留问题页，继续处理其他篇。', 'codex-status'));
      if (t.literatureAutoOpenNotice && job.deferredOnly !== true) attention.append(node('p', t.literatureAutoOpenNotice, 'codex-status'));
      const actions = node('div', undefined, 'literature-confirm-actions');
      if (!deferredMaterials && (hasSourcePage || fulltextPaused)) {
        const open = node('button', fulltextPaused ? '查看原全文任务页' : job.deferredOnly === true ? '查看原页面' : '打开登录/检索页面', 'quiet-button'); open.type = 'button';
        open.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy();
        open.onclick = () => openLiteratureBrowser(mod);
        actions.append(open);
      }
      const resume = node('button', awaitingStart ? '开始检索' : fulltextPaused ? (materialsOnly ? '继续这篇材料' : job.cnkiRetryPaperId ? '继续这篇知网文献' : '继续获取全文') : job.resumeStage === 'extract' ? '继续提取' : job.deferredOnly === true ? '补检该来源' : '检查并继续', 'primary-button'); resume.type = 'button';
      resume.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameConfig;
      resume.onclick = () => job.cnkiRetryPaperId && fulltextPaused ? retryLiteratureCnki(mod, job.cnkiRetryPaperId)
        : continueLiterature(mod, fulltextPaused ? { until: 'fulltext' } : {});
      if (!deferredMaterials) actions.append(resume);
      if (replenishing && fulltextPaused && !deferredMaterials) {
        const deferAccess = node('button', '先留待处理，继续其他文献', 'primary-button'); deferAccess.type = 'button';
        deferAccess.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameConfig;
        deferAccess.onclick = () => continueLiterature(mod, { until: 'fulltext', deferAccess: true }); actions.append(deferAccess);
      }
      if (fulltextPaused && !job.cnkiRetryPaperId && !replenishing) {
        const skip = node('button', '跳过无法获取的文献，继续', 'primary-button'); skip.type = 'button';
        skip.title = '本任务无法取得的正文或补充材料记入待补充清单，继续下一篇；保留已保存材料，只运行到全文获取。';
        skip.disabled = t.literatureBusy || t.busy || !!root.LiteratureUI?.isBusy() || !sameConfig;
        skip.onclick = () => continueLiterature(mod, { until: 'fulltext', skipUnavailable: true });
        actions.append(skip);
      }
      if (fulltextPaused && job.cnkiRetryPaperId && !materialsOnly && job.cnkiRetryItems?.some(item => item.id === job.cnkiRetryPaperId)) {
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
    if (t.literatureConfig && !segment) {
      const config = t.literatureConfig;
      const details = node('details', undefined, 'literature-config');
      details.open = typeof t.literatureConfigOpen === 'boolean' ? t.literatureConfigOpen : !awaitingAccess;
      let lastConfigOpen = details.open;
      function rememberConfigOpen(open) {
        t.literatureConfigOpen = open;
        saved[mod.id] = { ...saved[mod.id], literatureConfigOpen: open };
        persist();
      }
      const summary = node('summary', '本次检索设置（点击查看或修改）' + (saved[mod.id]?.literatureSource !== literatureSource(mod) ? ' · 对话已更新' : ''));
      // Capture the user's choice before the native asynchronous toggle event,
      // so a polling render cannot replace the panel with the old default.
      summary.onclick = event => { if (!event?.defaultPrevented) rememberConfigOpen(!details.open); };
      details.ontoggle = () => {
        if (!details.isConnected || details.open === lastConfigOpen) return;
        lastConfigOpen = details.open;
        if (t.literatureConfigOpen !== details.open) rememberConfigOpen(details.open);
      };
      details.append(summary);
      details.append(node('p', '这里是本次任务的要求表。核对检索什么、检索范围和需要提取的字段；修改后再开始执行。', 'codex-status'));
      const fields = node('div', undefined, 'literature-config-fields');
      function input(label, key, type = 'text') {
        const wrap = node('label', label); const field = node('input'); field.type = type;
        if (key === 'query') field.maxLength = 32768;
        if (type === 'number') { field.min = '1800'; field.max = String(new Date().getFullYear() + 1); }
        field.value = config[key] ?? ''; field.oninput = () => { config[key] = type === 'number' ? (field.value ? Number(field.value) : null) : field.value; persistConfig(); };
        wrap.append(field); fields.append(wrap);
      }
      function lines(label, key) {
        const wrap = node('label', label); const field = node('textarea'); field.rows = 2; field.value = literatureDraftRuleList(config[key]).join('\n');
        field.oninput = () => { config[key] = literatureDraftRuleList(field.value); persistConfig(); };
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
        if (value === 'formal' && config.scholarPlan?.trialMaxPages != null) label = '谷歌学术预试（最多' + config.scholarPlan.trialMaxPages + '页，仅候选）';
        const option = node('option', label); option.value = value; mode.append(option);
      });
      mode.value = config.searchMode || ''; mode.disabled = t.literatureBusy || t.busy || config.scholarPlan?.trialMaxPages != null;
      mode.onchange = () => {
        if (!['test', 'formal'].includes(mode.value)) return;
        config.searchMode = mode.value; config.stopMode = mode.value === 'formal' ? 'end' : 'count'; config.perSourceLimit = mode.value === 'formal' ? null : 10; config.limit = 10;
        if (config.batch) config.batch = { ...config.batch, size: 10 };
        resetDiscoverBudget(); persistConfig(); render();
      };
      modeWrap.append(mode); fields.append(modeWrap);
      const quantity = config.scholarPlan?.trialMaxPages != null ? '谷歌学术预试：最多保存' + config.scholarPlan.trialMaxPages + '页，仅候选；内部使用分页模式，不会运行整个正式研究，也不会下载全文或提取数据。短查询和年份可编辑，修改后需重新核查。'
        : !config.searchMode ? '历史配置保持原数量：每来源每批最多 ' + (config.batch?.size ?? config.limit ?? 10) + ' 条。继续原任务不会改变数量；切换模式将用于新检索。'
        : config.searchMode === 'formal' && config.stopMode !== 'end' ? '历史正式配置保持原数量：每来源候选上限 ' + (config.perSourceLimit ?? 100) + ' 条。继续原任务沿用原上限；发起新的正式检索会改为检索到可访问末页，不混用旧结果。'
        : config.searchMode === 'formal' ? '正式检索：自动翻页，直到各来源数据库当前可访问末页，不按候选数量停止。遇到登录、验证、网站访问限制或其他问题时暂停并保留已有结果；可访问末页不代表主题相关文献已全部获取。'
        : '测试运行：每个来源最多取10条候选，用于检查检索词和流程；不会自动扩大到正式数量。';
      details.append(node('p', quantity, 'codex-status'));
      const sources = node('div', undefined, 'literature-sources'); sources.append(node('span', '检索来源（按研究需要勾选）'));
      newLiteratureSourceOrder(Object.keys(LITERATURE_SOURCE_LABELS)).forEach(value => {
        const label = LITERATURE_SOURCE_LABELS[value];
        const wrap = node('label', label); const check = node('input'); check.type = 'checkbox'; check.checked = config.sources.includes(value);
        check.disabled = t.literatureBusy || t.busy || config.scholarPlan?.trialMaxPages != null;
        check.onchange = () => { config.sources = check.checked ? [...new Set([...config.sources, value])] : config.sources.filter(source => source !== value); resetDiscoverBudget(); persistConfig(); render(); };
        wrap.prepend(check); sources.append(wrap);
      });
      fields.append(sources);
      if (config.scholarPlan?.topics?.length) {
        const plan = node('details', undefined, 'literature-deliverable-group');
        plan.append(node('summary', '谷歌学术实际分批查询（' + config.scholarPlan.topics.length + '个主题，可修改）'));
        plan.append(node('p', (config.scholarPlan.version === 2 ? '以下查询先检索完整年份，过宽或截断才有限细分；' : '以下主题查询按5年区间执行；') + '按相关性排序。它们是实际执行的检索式，默认检索式和下方来源检索式不能代替此计划。', 'codex-status'));
        config.scholarPlan.topics.forEach(topic => {
          const wrap = node('label', topic.label || topic.id), field = node('textarea'); field.rows = 2; field.maxLength = 32768; field.value = topic.query || '';
          field.setAttribute('aria-label', '谷歌学术主题短查询 ' + (topic.label || topic.id)); field.disabled = t.literatureBusy || t.busy;
          field.oninput = () => {
            topic.query = field.value;
            if (config.scholarPlan.trialMaxPages != null && config.scholarPlan.topics.length === 1) { config.query = field.value; config.sourceQueries = { ...config.sourceQueries, 'google-scholar': field.value }; }
            persistConfig();
          }; wrap.append(field); plan.append(wrap);
        });
        fields.append(plan);
      }
      newLiteratureSourceOrder(config.sources).forEach(source => {
        const wrap = node('label', (LITERATURE_SOURCE_LABELS[source] || source) + ' 检索式（留空沿用默认）');
        const field = node('textarea'); field.rows = 2; field.maxLength = 32768;
        field.value = config.sourceQueries?.[source] || ''; field.disabled = t.literatureBusy || t.busy;
        if (source === 'google-scholar' && config.scholarPlan) { field.readOnly = true; wrap.append(node('small', '已启用分批计划，请在上方“实际分批查询”修改短查询。')); }
        const examples = {
          'google-scholar': '例如：broiler "heat stress" "growth performance"',
          cnki: '例如：肉鸡 热应激 增重',
          wanfang: '例如：肉鸡 高温 生长性能',
          'web-of-science': '例如：(broiler OR broilers) AND ("heat stress" OR "high temperature") AND growth',
          scopus: '例如：(broiler OR broilers) AND ("heat stress" OR "high temperature") AND growth（Documents：Title Abstract Keywords）'
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
      if (t.literatureConfigNotice) box.append(node('p', t.literatureConfigNotice, 'codex-status'));
      if (config.sources.some(source => !LITERATURE_SOURCE_LABELS[source])) box.append(node('p', '配置含无法识别的来源，请重新选择本次检索来源。', 'codex-error'));
      if (job && !sameConfig) box.append(node('p', '当前设置与已有任务的冻结配置不同。继续旧任务请从历史任务重新载入；确认新设置并检索会创建新任务，不混用旧结果。', 'codex-status'));
    } else if (!segment) box.append(node('p', '先在本模块对话讨论规则，再点“从对话更新规则并核查”。AI 生成的是候选配置，需你核对后才会执行。', 'codex-status'));
    if (!job) box.append(node('p', '检索来源固定为 Google Scholar、中国知网、万方、Web of Science 核心合集、Scopus 五库，按研究需要勾选。需要登录、验证或机构权限时会暂停，请在官方页面操作后继续。全文提取前需要你确认参数字段含义与单位。', 'codex-status'));
    if (job) {
      const deliverables = literatureDeliverables(job);
      if (deliverables) box.append(deliverables);
      if (Array.isArray(job.events) && job.events.length > 1) {
        // 轮询会反复重建面板；展开状态、面板滚动和这段日志自身的滚动都必须跟着
        // 任务走。日志段落自带 max-height + overflow，重置它才是“下滑弹回顶部”。
        const details = node('details'); details.open = t.literatureStageOpen === true;
        details.append(node('summary', '查看阶段记录'));
        const stageLog = node('pre', job.events.map(event => event.message).join('\n'));
        stageLog.className = 'literature-stage-log';
        stageLog.addEventListener('scroll', () => { t.literatureStageScroll = stageLog.scrollTop; });
        details.append(stageLog);
        details.addEventListener('toggle', () => { t.literatureStageOpen = details.open; });
        box.append(details);
      }
    }
    box.append(literatureHistory(mod, t));
    if (t.literatureError) box.append(node('p', t.literatureError, 'codex-error'));
    if (typeof compactLiteraturePanel === 'function') compactLiteraturePanel(mod, t, box);
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
    // 同步预检：Codex 未连接时立即抛出（chat 层据此自动回落到 API 对话），
    // 避免先建 job 再在轮询里失败——新用户看到的是 AI 回复而不是登录报错。
    try { account = await request('/api/codex/status'); }
    catch (error) { account = { loggedIn: false, error: error.message }; }
    if (!account.loggedIn) throw new Error('请先在终端执行 codex login，用 ChatGPT 账号登录。');
    const executeRequested = t.executeOnce || t.execute;
    const cleanPlan = module.type === 'clean-data' && executeRequested ? t.preparedCleanPlan : undefined;
    if (module.type === 'clean-data' && executeRequested) {
      const basis = basisForClean(module);
      if (!cleanPlan || !basis || basis.text !== cleanPlan.text || basis.version !== cleanPlan.version || JSON.stringify(cleanPlan.standardNames || [])!==JSON.stringify(cleanStandardNames(module.id))) throw new Error('请先核对并确认当前清洗方案及标准原件，再从方案入口执行。');
    }
    const plotPlan = module.type === 'plotting' && executeRequested ? t.preparedPlotPlan : undefined;
    if (module.type === 'plotting' && executeRequested && !plotPlan) throw new Error('请在绘图方案中审核后点击生成');
    t.preparedPlotPlan = null;
    t.preparedCleanPlan = null;
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
      if (module.type === 'clean-data' && batch) messages = [{ role: 'user', text: '当前下载交接批次（来源信息，不替代本模块的清洗规则）：\n仅处理以下当前输入文件，其他 input 文件为历史保留，不自动合并：\n' + batch.names.filter(name=>!cleanStandardNames(module.id).includes(name)).join('\n') + '\n获取依据：' + batch.label + '\n' + batch.text.slice(0, 1500) }, ...messages];
      if (module.type === 'clean-data' && cleanStandardNames(module.id).length) messages=[{role:'user',text:'本模块提供的人工核验标准原件（reference目录；提供文件不表示已经采纳或通过）：\n'+cleanStandardNames(module.id).map(name=>'reference/'+name).join('\n')+'\n讨论时先读取能够解析的原件，把拟采用标准整理到同一清洗方案的“人工核验标准”，每项写明核验内容、方法、通过条件、必需与否，依据引用完整原件名及页/节。未能读取或存在歧义时明确说明并提供原件，不能声称已完整理解。研究者确认方案后才采用；执行时不得代替人工签署核验通过。'},...messages];
      const job = await request('/api/codex/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, module: { type: module.type, step: module.step || null, mode: module.mode }, messages, execute: executeRequested, model: t.model || null, ...(plotPlan ? {plotPlan} : {}), ...(cleanPlan ? {cleanPlan} : {}), ...(module.type === 'clean-data' ? { cleanInputs: (Array.isArray(saved[module.id]?.cleanInputs) ? saved[module.id].cleanInputs : (Array.isArray(cleanPlan?.inputs) ? cleanPlan.inputs : [])) } : {}) }) });
      if (cleanPlan) { t.cleanAcceptanceRunId = job.id; t.cleanAcceptance = null; t.cleanAcceptanceKey = null; saved[module.id].cleanAcceptanceRunId = job.id; Store.markRun(module.id, {dir:job.id,artifacts:[]}); Store.setModuleStatus(module.id,'doing'); }
      if (plotPlan) { t.plotSelectedRunId = job.id; saved[module.id].plotSelectedRunId = job.id; Store.setModuleStatus(module.id,'doing'); }
      if (cleanPlan) Store.setModuleStatus(module.id,'doing');
      saved[module.id].jobId = job.id; persist();
      await watch(module.id, job.id);
    } finally { t.busy = false; t.plotGenerating = false; render(); }
  }
  async function prepareConfirmedExecution(id) {
    const t = task(id);
    if (t.busy || root.ModuleSpace?.isBusy()) throw new Error('当前文件或 AI 任务尚未完成');
    if (t.backend !== 'codex') throw new Error('请先选择本机 Codex');
    const sid = await session(id);
    t.files = (await request('/api/codex/files?session=' + sid)).files;
    const mod = Store.getState().modules.find(item => item.id === id);
    if (mod?.type === 'clean-data') {
      const basis = basisForClean(mod);
      if (!basis) throw new Error('请先确认本模块清洗方案；草稿改变后须重新确认。');
      // Only a data file explicitly named by the approved plan can be rebound.
      // Reference originals remain available; a hash-checked input copy is used.
      const namedData = [...basis.text.matchAll(/(?:数据来源|输入文件|原始数据)[：:]\s*`([^`]+)`/g)].map(match=>match[1]);
      const referencedData = [...new Set(namedData)].filter(name=>t.files.some(file=>file.group==='reference' && file.name===name) && /\.(csv|tsv|xlsx|xls|parquet|json)$/i.test(name));
      if (referencedData.length) {
        const result = await request('/api/codex/clean/bind-input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,names:referencedData,confirm:true})});
        if (saved[id]?.sessionId!==sid || basisForClean(mod)?.text!==basis.text) throw new Error('任务或规则已改变，输入副本保留在原任务，请重新打开当前任务。');
        t.files=result.files;
        saved[id]={...saved[id],cleanStandardNames:cleanStandardNames(id).filter(name=>!result.boundSources.includes(name)),inputBatch:{...(saved[id]?.inputBatch || {}),names:result.inputNames,label:'已确认规则指定的原始数据',text:'原件保留，SHA-256一致的输入副本已绑定。'}};
        t.cleanStandardNotice='原规则指定的数据已接为清洗输入；参考原件、规则和讨论保留。';persist();
      }
      const prepared=root.CleanExecutionPlan?.prepare(basis.text);
      if (!t.files.some(file=>file.group==='input')) { render(); return false; }
      const standardNames=cleanStandardNames(id), compiled=root.CleanVerificationRules?.compile(prepared?.executionText || basis.text);
      if (standardNames.some(name=>!t.files.some(file=>file.group==='reference' && file.name===name))) throw new Error('标准原件缺失，请刷新并重新关联后讨论确认，原数据保留。');
      if (compiled?.manualChecks?.state==='needs_discussion') throw new Error('人工核验标准仍有待明确事项，请在同一方案补齐后确认。');
      if (standardNames.some(name=>!compiled?.manualChecks?.rules?.some(rule=>!rule.reason && [rule.basis,rule.sourceText].filter(Boolean).join('\n').includes(name)))) throw new Error('标准原件尚未落实为已确认的人工核验项。请在同一方案中整理，并在依据写明完整原件名。');
      const inputs = t.files.filter(file => file.group === 'input' && !standardNames.includes(file.name) && /\.(csv|tsv|xlsx|xls|json|txt)$/i.test(file.name)).map(file => file.name);
      const selected = saved[id]?.inputBatch?.names;
      const inputNames = Array.isArray(selected) ? inputs.filter(name => selected.includes(name)) : inputs;
      if (!inputNames.length) throw new Error('当前批次没有可用的清洗输入，请核对交接或上传文件。');
      t.preparedCleanPlan = {text:basis.text,version:basis.version,inputNames,standardNames};
    }
    if (!t.files.some(file => file.group === 'input')) { render(); return false; }
    if (mod?.type === 'clean-data') {
      const basis = root.TaskManager?.rulesForModule(id);
      const known = t.files.filter(file => file.group === 'input' && /\.(csv|tsv|xlsx|xls)$/i.test(file.name));
      const previous = Array.isArray(saved[id]?.cleanInputs) ? saved[id].cleanInputs : null;
      const batch = saved[id]?.inputBatch;
      const inputs = previous
        ? previous.filter(entry => known.some(file => file.name === entry.name))
        : known.filter(file => !batch || batch.names.includes(file.name)).map(file => ({ name: file.name, encoding: 'utf-8-sig', sheets: null }));
      if (!basis?.text || !inputs.length) throw new Error('请确认清洗规则，并在“数据检查与处理范围”中选择文件');
      t.preparedCleanPlan = { text: basis.text, version: basis.version, confirmed: true, inputs,
        inputNames: inputs.map(item => item.name), standardNames: Array.isArray(saved[id]?.cleanStandardNames) ? saved[id].cleanStandardNames : [] };
    }
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
  function cancelPreparedExecution(id) { task(id).executeOnce = false; task(id).preparedPlotPlan = null; task(id).preparedCleanPlan = null; render(); }
  function prepareRuleDiscussion(id) {
    const t = task(id);
    if (t.busy || root.ModuleSpace?.isBusy()) throw new Error('当前文件或 AI 任务尚未完成');
    t.execute = false; t.executeOnce = false; t.preparedPlotPlan = null; t.preparedCleanPlan = null;
    render();
  }
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
  async function discussDownloadVerification(mod) {
    if (!mod || mod.type !== 'download-data') return false;
    const t = task(mod.id);
    const state = Store.getState(), current = state.modules.find(item => item.id === mod.id);
    if (!current || current.type !== 'download-data' || state.activeModuleId !== mod.id) return false;
    if (t.busy || t.downloadVerificationOpening || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy()) return false;
    if (typeof root.ModuleSpace?.discussDownloadVerification !== 'function') {
      t.error = '核验方法讨论入口尚未载入，请刷新页面后再试。'; render(); return false;
    }
    t.downloadVerificationOpening = true; t.error = ''; render();
    try {
      const opened = await root.ModuleSpace.discussDownloadVerification(mod.id);
      if (opened !== true) throw new Error('当前无法打开核验方法讨论，请先处理正在进行的任务或未保存的编辑，再重试。');
      return true;
    } catch (error) { t.error = error.message; return false; }
    finally { t.downloadVerificationOpening = false; render(); }
  }
  function downloadVerificationControls(mod, t) {
    if (mod?.type !== 'download-data') return null;
    const box = node('section', undefined, 'download-verification-discussion');
    const discuss = node('button', t.downloadVerificationOpening ? '正在打开…' : '讨论核验方法', 'quiet-button'); discuss.type = 'button';
    discuss.setAttribute('aria-label', '讨论下载核验方法');
    discuss.disabled = !!(t.busy || t.downloadVerificationOpening || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy());
    discuss.title = '在同一份下载方案中讨论核验与验收，保留原已审核方案；不会开始下载或自动确认。';
    discuss.onclick = () => discussDownloadVerification(mod);
    box.append(discuss, node('p', '核验与验收写在同一份下载方案里。先讨论并查看草稿，核对后再决定是否保存；本入口不会下载或自动审核。', 'codex-status'));
    const currentPlan = mod.doc?.content || basisForDownload(mod)?.text;
    if (currentPlan && root.DownloadProfessionalRules) {
      const compiled = root.DownloadProfessionalRules.compile(currentPlan);
      const automatic = compiled.rules.filter(rule => rule.kind !== 'manual'), manual = compiled.rules.filter(rule => rule.kind === 'manual');
      const details = node('details'); details.open = false;
      details.append(node('summary', compiled.state === 'none' ? '本方案明确无额外专业规则（展开查看依据）'
        : '本方案专业规则：' + automatic.length + ' 项可自动检查，' + manual.length + ' 项需讨论或判断'));
      details.append(node('p', mod.doc?.status === 'approved' ? '已审核方案中的规则将用于下载后的实际数据检查；当前展示执行计划，不表示已经检查通过。' : '当前已保存方案仍待确认；审核后才会用于实际检查。这里不会开始下载。', 'codex-status'));
      if (compiled.rationale) details.append(node('p', compiled.rationale, 'codex-status'));
      compiled.rules.forEach(rule => details.append(node('p', rule.id + ' · ' + rule.label + '：' + (rule.kind === 'manual' ? '需判断：' + rule.reason : '可自动检查') + '；依据：' + rule.basis, 'codex-status')));
      box.append(details);
    } else box.append(node('p', '讨论方案时一并确定专业规则及依据。确认后检查实际数据；无法判断或暂不支持的项目会列入待处理。', 'codex-status'));
    return box;
  }
  function downloadAcceptanceContext(mod) {
    if (mod?.type !== 'download-data') return null;
    const state = saved[mod.id] || {}, run = state.download, t = task(mod.id);
    const id = state.sourceJobId || run?.sourceJobId || t.sourceJob?.id || null;
    if (!state.sessionId || (!id && !run?.files?.length)) return null;
    if (id && ((run?.sourceJobId && run.sourceJobId !== id) || (t.sourceJob?.id && t.sourceJob.id !== id))) return null;
    return { sessionId: state.sessionId, id, run, key: JSON.stringify([state.sessionId, id || 'legacy', id ? null : [run?.text, run?.files?.map(file => file.storedName)]]) };
  }
  function downloadAcceptanceReport(mod, t) {
    const scope = downloadAcceptanceContext(mod);
    if (!scope) return null;
    if (t.sourceAcceptanceKey === scope.key) return t.sourceAcceptance || null;
    const report = t.sourceJob?.id === scope.id ? t.sourceJob.verification : null;
    return report?.id && Array.isArray(report.checks) && Array.isArray(report.issues) ? report : null;
  }
  function downloadAcceptanceReady(report) {
    return !!(report?.id && report.status === 'ready' && Array.isArray(report.checks) && Array.isArray(report.issues)
      && !(report.summary?.blockingIssues > 0) && !(report.summary?.openDecisions > 0)
      && !report.issues.some(issue => issue.severity === 'error' || issue.resolution?.decision === 'reject'
        || (issue.decisionRequired && issue.resolution?.decision !== 'accept')));
  }
  function downloadAcceptanceCanHandoff(mod, t) {
    const run = saved[mod.id]?.download;
    return !!(!t.busy && !t.sourceAcceptanceLoading && !t.sourceAcceptanceBusy && !root.ModuleSpace?.isBusy()
      && run?.files?.length && !run.failures?.length && downloadAcceptanceReady(downloadAcceptanceReport(mod, t))
      && (!t.sourceJob || (t.sourceJob.status === 'completed' && run.sourceJobId === t.sourceJob.id)));
  }
  function downloadAcceptanceVerifyBody(mod, scope) {
    if (scope.id) return { sessionId: scope.sessionId, id: scope.id, confirm: true };
    const basis = basisForDownload(mod, scope.run?.sourceType);
    if (!scope.run?.files?.length || !basis?.text || basis.text !== scope.run.text) throw new Error('本批旧文件尚无可追溯核验记录；请先核对并审核对应的原下载方案，文件保留，不会重新下载。');
    const names = scope.run.files.map(file => file.storedName);
    if (names.some(name => typeof name !== 'string' || !name)) throw new Error('原下载记录的文件对应关系不完整，不能自动认定已核验。');
    return { sessionId: scope.sessionId, confirm: true, rules: basis.text, names, sources: scope.run.sources || [] };
  }
  function applyDownloadAcceptanceReport(mod, t, scope, report) {
    if (downloadAcceptanceContext(mod)?.key !== scope.key) throw new Error('当前下载批次已变化，核验回复没有应用到另一批文件，请重新载入。');
    if (!report || typeof report.id !== 'string' || !report.id || !['ready', 'needs_decision', 'blocked', 'rejected', 'checking'].includes(report.status)
      || !Array.isArray(report.checks) || !Array.isArray(report.issues) || (scope.id && report.jobId && report.jobId !== scope.id)) throw new Error('未收到可核对的完整验收报告；已有文件和方案保留。');
    if (!scope.id) {
      if (typeof report.jobId !== 'string' || !report.jobId || !scope.run) throw new Error('旧文件的核验记录尚未建立，未改变原下载记录。');
      const state = saved[mod.id]; state.sourceJobId = report.jobId; scope.run.sourceJobId = report.jobId;
      state.sourceBasis ||= { text: scope.run.text, label: scope.run.label, sourceType: scope.run.sourceType };
      t.sourceJob = { id: report.jobId, status: 'completed', kind: 'files', verification: report }; persist();
    } else if (t.sourceJob?.id === scope.id) t.sourceJob.verification = report;
    t.sourceAcceptance = report; t.sourceAcceptanceKey = downloadAcceptanceContext(mod).key;
    t.sourceAcceptanceLoadedKey = t.sourceAcceptanceKey; t.sourceAcceptanceError = '';
    return report;
  }
  async function loadDownloadAcceptance(mod, verify = false) {
    const t = task(mod.id), scope = downloadAcceptanceContext(mod);
    if (!scope || t.sourceAcceptanceLoading || t.sourceAcceptanceBusy || t.busy || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy()) return null;
    if (!scope.id && !verify) return null;
    const generation = t.sourceAcceptanceGeneration || 0;
    t.sourceAcceptanceLoading = true; t.sourceAcceptanceBusy = verify; t.sourceAcceptanceError = '';
    t.sourceAcceptanceLoadedKey = scope.key; render();
    try {
      const report = verify ? await request('/api/codex/source/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(downloadAcceptanceVerifyBody(mod, scope)) })
        : await request('/api/codex/source/verification?session=' + encodeURIComponent(scope.sessionId) + '&id=' + encodeURIComponent(scope.id));
      if (downloadAcceptanceContext(mod)?.key !== scope.key || (t.sourceAcceptanceGeneration || 0) !== generation) return null;
      if (!verify && (report === null || report?.status === 'not_checked')) { t.sourceAcceptance = null; t.sourceAcceptanceKey = scope.key; return null; }
      return applyDownloadAcceptanceReport(mod, t, scope, report);
    } catch (error) { if (downloadAcceptanceContext(mod)?.key === scope.key && (t.sourceAcceptanceGeneration || 0) === generation) t.sourceAcceptanceError = error.message; return null; }
    finally { if ((t.sourceAcceptanceGeneration || 0) === generation) { t.sourceAcceptanceLoading = false; t.sourceAcceptanceBusy = false; } render(); }
  }
  async function decideDownloadAcceptance(mod, reportId, issueId, decision, note) {
    const t = task(mod.id), scope = downloadAcceptanceContext(mod), report = downloadAcceptanceReport(mod, t);
    if (!scope?.id || t.busy || t.sourceAcceptanceLoading || t.sourceAcceptanceBusy || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy()) return false;
    const issue = report?.id === reportId && report.issues.find(item => item.id === issueId);
    if (!issue || issue.resolution || !['accept', 'reject'].includes(decision)
      || (decision === 'accept' && (issue.severity !== 'warning' || issue.canAccept !== true || !issue.decisionRequired))) {
      t.sourceAcceptanceError = '本项状态已变化，或不能接受该问题；请刷新核验报告后再处理。'; render(); return false;
    }
    if (typeof note !== 'string' || !note.trim() || note.trim().length > 2000) {
      t.sourceAcceptanceError = '请填写本项决定的理由（1至2000字），便于后续核查。'; render(); return false;
    }
    t.sourceAcceptanceBusy = true; t.sourceAcceptanceError = ''; render();
    try {
      const next = await request('/api/codex/source/verification/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: scope.sessionId, id: scope.id, reportId, issueId, decision, note: note.trim() }) });
      applyDownloadAcceptanceReport(mod, t, scope, next); return true;
    } catch (error) { t.sourceAcceptanceError = error.message; return false; }
    finally { t.sourceAcceptanceBusy = false; render(); }
  }
  function downloadAcceptanceArtifact(mod, artifact, label) {
    const name = typeof artifact === 'string' ? artifact : artifact?.name;
    if (typeof name !== 'string' || !name || /^[\\/]|^[a-z]:|^[a-z]+:\/\//i.test(name) || name.split(/[\\/]/).includes('..')) return null;
    const link = node('a', label || artifact?.label || '查看依据文件', 'quiet-button');
    link.href = '/api/codex/download?session=' + encodeURIComponent(saved[mod.id]?.sessionId || '') + '&group=output&name=' + encodeURIComponent(name); return link;
  }
  function downloadAcceptancePanel(mod, t) {
    const scope = downloadAcceptanceContext(mod), run = saved[mod.id]?.download;
    if (mod?.type !== 'download-data') return null;
    const box = node('section', undefined, 'download-acceptance-card'); box.setAttribute('aria-label', '下载核验与待处理问题');
    box.append(node('h3', '下载核验与待处理问题'));
    const report = downloadAcceptanceReport(mod, t);
    const checking = !!(t.sourceAcceptanceLoading || t.sourceAcceptanceBusy || report?.status === 'checking');
    const locked = !!(checking || t.busy || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy());
    if (scope?.id && t.sourceJob?.status !== 'running' && !t.busy && !t.sourceAcceptanceLoading && !t.sourceAcceptanceBusy
      && t.sourceAcceptanceLoadedKey !== scope.key && t.sourceAcceptanceQueuedKey !== scope.key) {
      t.sourceAcceptanceQueuedKey = scope.key;
      void Promise.resolve().then(() => { if (t.sourceAcceptanceQueuedKey === scope.key) t.sourceAcceptanceQueuedKey = null; return loadDownloadAcceptance(mod); });
    }
    const labels = { ready: '核验已就绪，仍待本批统一确认', needs_decision: '有变化或缺口需要决定', blocked: '存在阻断问题，需处理后重新核验', rejected: '已退回处理，尚不能交接', checking: '正在核验已有文件' };
    box.append(node('p', checking ? '正在读取或核验已有本地文件，不会重新下载。' : report ? labels[report.status]
      : !scope && !run?.files?.length ? '暂无本批文件。下载完成后可核验已有文件，不会自动重新下载。'
      : !scope && (saved[mod.id]?.sourceJobId || t.sourceJob?.id) ? '当前任务与文件批次尚不能对应，未显示通过；请刷新下载状态核对记录，原文件保留。'
      : scope?.id ? '本批尚无完整验收报告，未视为通过。' : '本批旧文件尚无验收报告；可核验已有文件并建立可追溯记录，不会重新下载。', 'codex-status'));
    const actions = node('div', undefined, 'codex-toolbar');
    const verify = node('button', '核验已有文件', 'quiet-button'); verify.type = 'button'; verify.disabled = !scope || locked;
    verify.onclick = () => loadDownloadAcceptance(mod, true); actions.append(verify);
    if (scope?.id) {
      const refresh = node('button', '刷新核验报告', 'quiet-button'); refresh.type = 'button';
      refresh.disabled = !!(t.sourceAcceptanceLoading || t.sourceAcceptanceBusy || t.busy || t.sourceJob?.status === 'running' || root.ModuleSpace?.isBusy());
      refresh.onclick = () => loadDownloadAcceptance(mod); actions.append(refresh);
    }
    box.append(actions);
    if (report) {
      const summary = report.summary || {}, baseline = report.baseline || {};
      const counts = [['currentRows', '本批记录'], ['baselineRows', '基准记录'], ['added', '新增'], ['revised', '修订'], ['removed', '删除'], ['schemaChanges', '字段变化'], ['unitChanges', '单位变化'], ['professionalPassed', '专业检查通过'], ['professionalPending', '专业检查待处理'], ['professionalExceptions', '专业例外已接受']]
        .filter(([key]) => Number.isFinite(summary[key])).map(([key, label]) => label + ' ' + summary[key]);
      if (counts.length) box.append(node('p', counts.join(' · '), 'codex-status'));
      const years = [['addedYears', '新增年份'], ['missingYears', '缺失年份']].filter(([key]) => Array.isArray(summary[key]) && summary[key].length)
        .map(([key, label]) => label + '：' + summary[key].join('、'));
      if (years.length) box.append(node('p', years.join('；'), 'codex-status'));
      box.append(node('p', baseline.mode === 'first' ? '首次获取：没有旧版可比较，不表示已完成更新差异核对。'
        : baseline.mode === 'comparable' ? '比较基准：' + (baseline.label || baseline.jobId || '已记录版本')
        : baseline.mode === 'incompatible' ? '旧版不可直接比较：' + (baseline.reason || '口径或结构不一致，需核对') : '比较基准以报告中的已记录范围为准。', 'codex-status'));
      const normal = node('details', undefined, 'download-acceptance-normal'); normal.open = false;
      const accepted = report.issues.filter(issue => issue.severity !== 'error' && issue.resolution?.decision === 'accept');
      const informational = report.issues.filter(issue => issue.severity !== 'error' && !issue.decisionRequired && !issue.resolution);
      normal.append(node('summary', '检查记录与已记录决定 · ' + (report.checks.length + accepted.length + informational.length) + ' 项（展开查看）'));
      report.checks.forEach(check => { const item = node('div'); item.append(node('strong', check.label || check.id), node('p', String(check.status || '') + (check.evidence ? ' · ' + (typeof check.evidence === 'string' ? check.evidence : JSON.stringify(check.evidence)) : ''), 'codex-status')); normal.append(item); });
      accepted.forEach(issue => normal.append(node('p', (issue.title || issue.id) + '：已接受本次变化/缺口；理由：' + (issue.resolution.note || '见决定记录'), 'codex-status')));
      informational.forEach(issue => normal.append(node('p', (issue.title || issue.id) + '：' + (issue.impact || issue.recommendation || '见报告记录'), 'codex-status')));
      box.append(normal);
      report.issues.filter(issue => issue.severity === 'error' || (issue.resolution?.decision !== 'accept' && (issue.decisionRequired || issue.resolution?.decision === 'reject'))).forEach(issue => {
        const item = node('section', undefined, 'download-acceptance-issue'); item.setAttribute('aria-label', '待处理问题 ' + issue.id);
        item.append(node('h4', '问题：' + (issue.title || issue.id)), node('p', '影响：' + (issue.impact || '请核对报告中的影响范围。')));
        const evidence = node('details'); evidence.open = false; evidence.append(node('summary', '查看依据与已尝试的处理'));
        (Array.isArray(issue.evidence) ? issue.evidence : []).forEach(value => {
          evidence.append(node('p', [value.label, value.detail].filter(Boolean).join('：')));
          const link = downloadAcceptanceArtifact(mod, value.artifact); if (link) evidence.append(link);
        });
        const attempts = Array.isArray(issue.attempts) ? issue.attempts : [];
        evidence.append(node('p', '已尝试：' + (attempts.length ? attempts.map(value => typeof value === 'string' ? value : [value.label, value.detail, value.outcome].filter(Boolean).join('；')).join('；') : '尚无已记录的处理尝试。'), 'codex-status'));
        item.append(evidence, node('p', '建议：' + (issue.recommendation || '核对依据后处理，再核验已有文件。')));
        if (issue.resolution?.decision === 'reject') item.append(node('p', '已退回：' + (issue.resolution.note || '见决定记录') + '；处理后重新核验。', 'codex-error'));
        else {
          item.append(node('p', issue.severity === 'error' ? '此项不能强行接受；请处理原因后重新核验。' : issue.decisionPrompt || (issue.decisionRequired ? '需要你决定是否接受本次变化或缺口。' : '此项尚待处理，尚未视为通过。'), 'codex-status'));
          const note = node('textarea'); note.rows = 2; note.maxLength = 2000; note.setAttribute('aria-label', '决定理由 ' + issue.id); note.placeholder = '写明依据和本次决定的理由'; note.disabled = locked;
          const noteKey = report.id + ':' + issue.id; t.sourceAcceptanceNotes ||= {}; note.value = t.sourceAcceptanceNotes[noteKey] || '';
          note.oninput = () => { t.sourceAcceptanceNotes[noteKey] = note.value; }; item.append(note);
          if (issue.severity === 'warning' && issue.canAccept === true && issue.decisionRequired) {
            const accept = node('button', '接受本次变化/缺口', 'quiet-button'); accept.type = 'button'; accept.disabled = locked;
            accept.onclick = () => decideDownloadAcceptance(mod, report.id, issue.id, 'accept', note.value); item.append(accept);
          }
          const reject = node('button', '退回处理', 'quiet-button'); reject.type = 'button'; reject.disabled = locked;
          reject.onclick = () => decideDownloadAcceptance(mod, report.id, issue.id, 'reject', note.value); item.append(reject);
        }
        box.append(item);
      });
      const files = node('details'); files.open = false; files.append(node('summary', '下载完整核验报告与差异依据'));
      (Array.isArray(report.artifacts) ? report.artifacts : []).forEach(artifact => { const link = downloadAcceptanceArtifact(mod, artifact); if (link) files.append(link); }); box.append(files);
      if (downloadAcceptanceReady(report)) box.append(node('p', '需决定事项已处理。请核对本批后点击“确认文件并进入清洗”一次统一确认；这里不会自动确认或执行清洗。', 'codex-status'));
    }
    if (t.sourceAcceptanceError) box.append(node('p', t.sourceAcceptanceError, 'codex-error'));
    return box;
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
  function parseDownloadSources(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return { sources: [], error: '尚未填写实际文件地址。灰色文字只是提示，审核方案后仍需取得下载地址。' };
    if (lines.length > 5) return { sources: [], error: '一次最多下载 5 个文件，请分批填写。' };
    const sources = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split('|'), source = { url: parts[0].trim(), name: parts.slice(1).join('|').trim() };
      let url;
      try { url = new URL(source.url); } catch (_) { return { sources: [], error: '第 ' + (i + 1) + ' 行不是有效地址，请粘贴完整的 HTTP(S) 文件链接。' }; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { sources: [], error: '第 ' + (i + 1) + ' 行须使用不含登录凭据的 HTTP(S) 文件地址。' };
      if (/(^|\.)example\.(org|com|net)$/i.test(url.hostname)) return { sources: [], error: '第 ' + (i + 1) + ' 行是示例地址，请替换为真实文件下载地址。' };
      if (/(^|\.)fao\.org$/i.test(url.hostname) && /\/faostat(?:\/|$)/i.test(url.pathname) && url.hash) return { sources: [], error: '第 ' + (i + 1) + ' 行是 FAOSTAT 查询页面，需先导出文件；页面地址不能作为数据文件下载。' };
      sources.push(source);
    }
    return { sources, error: '' };
  }
  function updateDownloadForm() {
    const parsed = parseDownloadSources(document.getElementById('download-sources').value);
    const busy = downloadModuleId && task(downloadModuleId).busy;
    document.getElementById('download-start').disabled = !!busy || !!parsed.error;
    if (!busy) document.getElementById('download-status').textContent = parsed.error || '已填写 ' + parsed.sources.length + ' 个地址。开始前请核对其年份、范围和文件名；查询页面可能无法直接下载。';
    return parsed;
  }
  function sourceRequestBody(mod, basis) {
    const t = task(mod.id), body = { sessionId: saved[mod.id]?.sessionId, rules: basis.text, confirm: true, backend: t.backend, model: t.model || null };
    if (t.backend === 'api') {
      try { body.settings = Store.llmSettings.resolve(Store.llmSettings.read()); } catch (_) { body.settings = null; }
      body.credential = root.ApiKeys?.getActiveCredential?.() || null;
    }
    return body;
  }
  async function startSourceDownload(mod, basis, resume = false) {
    const t = task(mod.id);
    if (t.busy || root.ModuleSpace?.isBusy()) return false;
    t.busy = true; t.error = ''; t.job = null; render();
    try {
      const sid = await session(mod.id);
      const current = Store.getState().modules.find(item => item.id === mod.id);
      const approved = current && basisForDownload(current, basis.sourceType);
      if (!approved || approved.text !== basis.text) throw new Error('方案已变化，请重新审核后再执行');
      const body = sourceRequestBody(mod, basis); body.sessionId = sid;
      if (resume) body.id = saved[mod.id]?.sourceJobId;
      const job = await request('/api/codex/source/' + (resume ? 'resume' : 'start'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      saved[mod.id] = { ...saved[mod.id], sourceJobId: job.id, sourceBasis: { ...basis } }; persist();
      t.sourceJob = job;
      Store.rejectRun(mod.id, 'data', '已按当前方案启动下载，新的交付须重新检查'); Store.setModuleStatus(mod.id, 'doing');
      await watchSourceDownload(mod.id, job.id);
    } catch (error) { t.error = error.message; }
    finally { if (!t.sourceJob || t.sourceJob.status !== 'running') t.busy = false; render(); ModuleSpace.render(); }
    return true;
  }
  async function watchSourceDownload(id, jobId) {
    const t = task(id);
    if (t.sourceWatching) return;
    t.sourceWatching = true; t.busy = true; t.sourceWatchError = ''; render();
    try {
      while (true) {
        const job = await request('/api/codex/source/status?session=' + encodeURIComponent(saved[id]?.sessionId || '') + '&id=' + encodeURIComponent(jobId));
        if (job.status !== 'running') {
          const acceptanceStamp = JSON.stringify([saved[id]?.sessionId, job.id, job.status, job.verification?.id, job.verification?.status]);
          if (t.sourceAcceptanceTerminalStamp !== acceptanceStamp) {
            t.sourceAcceptanceGeneration = (t.sourceAcceptanceGeneration || 0) + 1;
            t.sourceAcceptance = null; t.sourceAcceptanceKey = null; t.sourceAcceptanceLoadedKey = null; t.sourceAcceptanceQueuedKey = null;
            t.sourceAcceptanceLoading = false; t.sourceAcceptanceBusy = false;
            t.sourceAcceptanceTerminalStamp = acceptanceStamp;
          }
        }
        t.sourceJob = job; t.files = job.files || t.files; render();
        if (job.status !== 'running') {
          const stamp = job.id + ':' + job.status;
          if (saved[id]?.sourceDelivered !== stamp) {
            const basis = saved[id]?.sourceBasis;
            if (job.status === 'completed' && basis) {
              saved[id].download = { ...basis, sources: job.kind === 'faostat-tm' ? [{ url: job.archive?.finalUrl || '' }] : [], files: job.deliverables || [], failures: [], confirmed: false, sourceJobId: job.id };
              Store.markRun(id, { dir: '.workbench/' + saved[id].sessionId + '/input', artifacts: job.deliverables.map(file => ({ name: file.storedName, size: file.size })) });
              Store.appendMessage(id, job.kind === 'faostat-tm' ? '官方贸易矩阵原包已完整保存；已按方案筛选 ' + (job.config?.years || []).join('、') + ' 年，共 ' + (job.result?.rowsSelected || 0).toLocaleString() + ' 行。原包、按年CSV、来源与筛选报告可在下载任务中保存。尚未通过人工验收，请检查后再交给清洗。' : '已按审核方案下载 ' + job.deliverables.length + ' 个文件，原始文件和来源记录已保存。请检查后再交给清洗。', 'system');
              t.filesOpen = true;
            } else Store.appendMessage(id, '下载任务' + ({ failed: '未完成', cancelled: '已停止', interrupted: '被中断' }[job.status] || job.status) + '：' + (job.error || job.message) + '。已有原件和断点保留，可在同一方案下继续。', 'system');
            saved[id].sourceDelivered = stamp; persist();
          }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    } catch (error) { t.sourceWatchError = '暂时无法读取下载进度：' + error.message + '。点击“刷新下载状态”找回原任务。'; }
    finally { t.sourceWatching = false; t.busy = t.sourceJob?.status === 'running'; render(); ModuleSpace.render(); }
  }
  function sourceDownloadPanel(mod, t) {
    const job = t.sourceJob;
    if (!job && !saved[mod.id]?.sourceJobId) return;
    const box = node('section', undefined, 'source-download-progress');
    box.append(node('h3', job?.kind === 'faostat-tm' ? 'FAOSTAT 官方贸易矩阵下载' : '按方案下载任务'));
    const labels = { running: '进行中', completed: '已完成 · 待人工检查', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
    box.append(node('p', (labels[job?.status] || '正在找回任务') + ' · ' + (job?.message || '正在读取进度')));
    if (job?.config) box.append(node('p', '年份：' + job.config.years.join('、') + '；' + job.config.scopeNote, 'codex-status'));
    const p = job?.progress || {};
    if (p.bytes !== undefined) {
      const mib = value => (value / 1024 ** 2).toFixed(1) + ' MiB';
      box.append(node('p', '已接收 ' + mib(p.bytes) + (p.totalBytes ? ' / ' + mib(p.totalBytes) : '') + (p.resumedBytes ? '（从断点继续）' : ''), 'codex-status'));
      if (p.totalBytes) { const bar = node('progress'); bar.max = p.totalBytes; bar.value = p.bytes; bar.setAttribute('aria-label', '原始文件下载进度'); box.append(bar); }
    }
    if (p.rowsRead !== undefined) box.append(node('p', '已扫描 ' + p.rowsRead.toLocaleString() + ' 行，保留 ' + (p.rowsSelected || 0).toLocaleString() + ' 行。原始列、代码、单位、数值与标记保留。', 'codex-status'));
    const actions = node('div', undefined, 'codex-toolbar');
    const refresh = node('button', '刷新下载状态', 'quiet-button'); refresh.type = 'button'; refresh.disabled = t.sourceWatching;
    refresh.onclick = () => watchSourceDownload(mod.id, saved[mod.id].sourceJobId); actions.append(refresh);
    if (job?.status === 'running') {
      const stop = node('button', '停止下载任务', 'quiet-button'); stop.type = 'button'; stop.onclick = async () => {
        stop.disabled = true;
        try { await request('/api/codex/source/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: saved[mod.id].sessionId, id: job.id }) }); }
        catch (error) { t.sourceWatchError = error.message; render(); }
      }; actions.append(stop);
    } else if (job && job.status !== 'completed') {
      const resume = node('button', '按原方案继续', 'primary-button'); resume.type = 'button'; resume.disabled = t.busy;
      resume.onclick = () => { const basis = basisForDownload(mod, saved[mod.id]?.sourceBasis?.sourceType); if (!basis || basis.text !== saved[mod.id]?.sourceBasis?.text) { t.error = '方案已变化，请审核后开始新任务，原下载文件保留'; render(); return; } startSourceDownload(mod, basis, true); }; actions.append(resume);
    }
    const addDownload = (label, group, name) => { const link = node('a', label, 'quiet-button'); link.href = '/api/codex/download?session=' + encodeURIComponent(saved[mod.id].sessionId) + '&group=' + group + '&name=' + encodeURIComponent(name); actions.append(link); };
    if (job?.archive) addDownload('下载官方完整原包', 'output', job.archive.name);
    (job?.deliverables || []).forEach(file => addDownload('下载 ' + file.name, 'input', file.storedName));
    if (job?.status === 'completed') addDownload('下载来源与检查报告', 'output', job.id + (job.kind === 'faostat-tm' ? '/source-and-filter-report.json' : '/source-report.json'));
    box.append(actions);
    if (job?.error || t.sourceWatchError) box.append(node('p', t.sourceWatchError || job.error, 'codex-error'));
    panel.append(box);
  }
  function openDownload(mod, basis, options = {}) {
    if (mod?.type !== 'download-data') return false;
    const t = task(mod.id);
    if (t.busy || root.ModuleSpace?.isBusy()) return false;
    basis = basis || basisForDownload(mod);
    if (!basis?.text) { t.error = '请先确认上方下载规则，或审核下载方案，再开始下载。'; render(); return false; }
    if (!options.manual && ((/FAOSTAT|fao\.org/i.test(basis.text) && /贸易矩阵|Detailed\s*trade\s*matrix|\bTM\b/i.test(basis.text)) || /https?:\/\/[^\s]+\.(csv|tsv|xlsx|xls|json|txt|zip|pdf|xml|md)(?:[?\s]|$)/i.test(basis.text))) { startSourceDownload(mod, basis); return true; }
    downloadModuleId = mod.id; downloadBasis = basis;
    document.getElementById('download-basis').textContent = basis.label + '\n' + basis.text;
    const previous = saved[mod.id]?.download?.sources;
    const urls = (basis.text.match(/https?:\/\/[^\s<>"\]]+/g) || []).map(url => url.replace(/[，。；）]+$/, ''))
      .filter(url => /\.(csv|tsv|xlsx|xls|json|txt|zip|pdf|xml|md)$/i.test(url.split(/[?#]/)[0]));
    document.getElementById('download-sources').value = previous ? previous.map(source => source.url + (source.name ? ' | ' + source.name : '')).join('\n') : urls.slice(0, 5).join('\n');
    document.getElementById('download-site-help').hidden = !/FAOSTAT|fao\.org/i.test(basis.text) || !/贸易矩阵|Detailed\s*trade\s*matrix|\bTM\b/i.test(basis.text);
    updateDownloadForm();
    document.getElementById('download-dialog').showModal();
    return true;
  }
  document.getElementById('download-close').onclick = () => document.getElementById('download-dialog').close();
  document.getElementById('download-sources').oninput = updateDownloadForm;
  document.getElementById('download-start').onclick = async () => {
    if (!downloadModuleId || !downloadBasis) return;
    const id = downloadModuleId, basis = downloadBasis, t = task(id);
    if (t.busy || root.ModuleSpace?.isBusy()) return;
    const status = document.getElementById('download-status');
    const current = Store.getState().modules.find(mod => mod.id === id);
    const approved = current && basisForDownload(current, basis.sourceType);
    if (!approved || approved.text !== basis.text) { status.textContent = '下载方案已变化，请重新审核并打开下载窗口。'; return; }
    const parsed = updateDownloadForm();
    if (parsed.error) return;
    const sources = parsed.sources;
    t.busy = true; t.error = ''; t.job = null; document.getElementById('download-start').disabled = true; render();
    document.getElementById('download-sources').disabled = true;
    const run = { ...basis, sources, files: [], failures: [], confirmed: false };
    let completed = false;
    try {
      const sid = await session(id);
      Store.rejectRun(id, 'data', '开始重新下载；本次结果须重新检查并确认。');
      Store.setModuleStatus(id, 'doing');
      delete saved[id].sourceJobId; delete saved[id].sourceBasis;
      t.sourceJob = null; t.sourceAcceptanceGeneration = (t.sourceAcceptanceGeneration || 0) + 1;
      t.sourceAcceptance = null; t.sourceAcceptanceKey = null; t.sourceAcceptanceLoadedKey = null; t.sourceAcceptanceQueuedKey = null;
      t.sourceAcceptanceTerminalStamp = null; t.sourceAcceptanceError = ''; t.sourceAcceptanceLoading = false; t.sourceAcceptanceBusy = false;
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
      completed = count === sources.length && count > 0 && !run.failures.length;
      status.textContent = (completed ? '下载完成' : '下载尚未完成') + '：成功 ' + count + ' 个，失败 ' + run.failures.length + ' 个。' + (completed ? '正在核验本批已有文件，核验后仍需确认交给清洗。' : '成功文件已保留，失败项仍待处理，暂不交给清洗。');
      Store.appendMessage(id, basis.label + '：下载成功 ' + count + ' 个，失败 ' + run.failures.length + ' 个。原始文件和下载记录在“文件与结果”中；年份、范围和版本仍待核查。' + run.failures.map(item => '\n失败：' + item.source.url + '；' + item.error).join(''), 'system');
      if (completed) Store.markRun(id, { dir: '.workbench/' + sid + '/input', artifacts: run.files.map(file => ({ name: file.storedName, size: file.size })) });
      t.filesOpen = true;
    } catch (error) { completed = false; status.textContent = error.message; t.error = error.message; }
    finally { t.busy = false; document.getElementById('download-start').disabled = !!parseDownloadSources(document.getElementById('download-sources').value).error; document.getElementById('download-sources').disabled = false; render(); ModuleSpace.render(); }
    if (completed && saved[id]?.download === run) {
      const report = await loadDownloadAcceptance(current, true);
      status.textContent = '下载完成：成功 ' + run.files.length + ' 个。' + (report ? '核验结果已显示在待处理问题中，仍需本批统一确认。' : '本批核验尚未就绪，请查看核验提示；已有文件保留。');
    }
  };
  async function handoffDownload(mod) {
    const t = task(mod.id), run = saved[mod.id]?.download;
    if (t.busy || t.sourceAcceptanceLoading || t.sourceAcceptanceBusy || !run?.files.length || root.ModuleSpace?.isBusy()) return;
    if (saved[mod.id]?.sourceJobId && (run.sourceJobId !== saved[mod.id].sourceJobId || t.sourceJob?.status !== 'completed')) { t.error = '当前下载任务尚未完成，请检查当前结果后再交接'; render(); return; }
    if (run.failures.length) { t.error = '仍有下载失败，请补齐清单后再交给清洗。成功文件已保留。'; render(); return; }
    const basis = basisForDownload(mod, run.sourceType);
    if (!basis || basis.text !== run.text) { t.error = '下载规则已变化，请先按当前规则重新核查或下载文件。'; render(); return; }
    t.busy = true; t.error = ''; render();
    try {
      const scope = downloadAcceptanceContext(mod);
      if (!scope) throw new Error('本批文件的来源记录尚不能核对，请先核验已有文件；不会重新下载。');
      t.sourceAcceptanceBusy = true; render();
      const verification = applyDownloadAcceptanceReport(mod, t, scope, await request('/api/codex/source/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(downloadAcceptanceVerifyBody(mod, scope)) }));
      t.sourceAcceptanceBusy = false;
      if (!downloadAcceptanceReady(verification)) throw new Error('本批核验尚未就绪；请先处理核验卡中的问题或待决定事项，再统一确认文件。');
      const current = Store.getState().modules.find(item => item.id === mod.id), currentBasis = current && basisForDownload(current, run.sourceType);
      if (!currentBasis || currentBasis.text !== run.text || saved[mod.id]?.download !== run) throw new Error('核验期间方案或批次已变化，未交接；请核对当前批次。');
      let clean = Store.getState().modules.find(item => item.type === 'clean-data');
      if (!clean) { Store.addModule('数据清洗'); clean = Store.getState().modules.find(item => item.type === 'clean-data'); }
      if (!clean) throw new Error('无法建立清洗模块');
      let target = await session(clean.id), existing;
      try { existing = (await request('/api/codex/files?session=' + target)).files; }
      catch (error) {
        if (error.code !== 'SESSION_NOT_FOUND' || error.sessionId !== target) throw error;
        // A lost target must never cause the successful download source to be replaced.
        try {
          const sourceFiles = (await request('/api/codex/files?session=' + saved[mod.id].sessionId)).files;
          if (!run.files.every(file => sourceFiles.some(source => source.group === 'input' && source.name === file.storedName))) throw new Error('下载记录对应的原始文件未找到，请先找回原文件；下载方案和记录已保留。');
        }
        catch (sourceError) {
          if (sourceError.code === 'SESSION_NOT_FOUND') throw new Error('下载源文件会话已失效，请先找回原文件；本次下载记录和方案已保留。');
          throw sourceError;
        }
        const previous = target;
        target = (await request('/api/codex/session', { method: 'POST' })).id;
        saved[clean.id].sessionId = target;
        run.confirmed = false;
        persist();
        Store.appendMessage(clean.id, '原清洗文件接收区已失效（' + previous + '），已建立新的接收区。已有方案和对话保留，正在重新交接现存下载文件；尚未执行清洗。', 'system');
      }
      if (run.confirmed && existing) {
        const names = saved[clean.id].inputBatch?.names;
        if (!names?.length || !names.every(name => existing.some(file => file.group === 'input' && file.name === name))) throw new Error('此前交接的清洗输入文件未找到，请先检查“文件与结果”；下载原文件和记录已保留。');
        task(clean.id).files = existing; task(clean.id).filesOpen = true; task(clean.id).error = '';
        Store.selectModule(clean.id); return;
      }
      const result = await request('/api/codex/import-input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: target, sourceSessionId: saved[mod.id].sessionId, names: run.files.map(file => file.storedName), confirm: true,
        sourceJobId: saved[mod.id].sourceJobId, verificationReportId: verification.id }) });
      task(clean.id).files = result.files; task(clean.id).filesOpen = true; task(clean.id).error = '';
      saved[clean.id].inputBatch = { names: result.names, label: run.label, text: run.text, verification: { sourceJobId: saved[mod.id].sourceJobId, reportId: verification.id } };
      run.confirmed = true; persist(); Store.confirmRun(mod.id);
      Store.appendMessage(mod.id, '已人工确认 ' + run.files.length + ' 个下载文件并交给数据清洗。' + (run.failures.length ? '本次仍有 ' + run.failures.length + ' 个下载失败，须另行补充。' : ''), 'system');
      Store.appendMessage(clean.id, '已接收下载模块确认的 ' + run.files.length + ' 个原始文件，依据“' + run.label + '”。\n来源与获取要求（用于交接，清洗规则另行确认）：\n' + run.text + '\n交接文件：\n' + run.files.map(file => file.name + '；来源：' + file.finalUrl + '；SHA-256：' + file.sha256).join('\n') + '\n请先查看输入并讨论清洗规则，再执行清洗。', 'system');
      Store.approveModule(mod.id);
      Store.selectModule(clean.id);
    } catch (error) { t.error = error.code === 'SESSION_NOT_FOUND' && error.sessionId === saved[mod.id].sessionId ? '下载源文件会话已失效，请先找回原文件；本次下载记录和方案已保留。' : error.message; }
    finally { t.sourceAcceptanceBusy = false; t.busy = false; render(); ModuleSpace.render(); }
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
  function basisForClean(mod) {
    const rules = root.TaskManager?.rulesForModule(mod.id);
    if (rules?.dirty) return null;
    if (rules?.text) return {text:rules.text,version:rules.version || 1};
    return mod.doc?.status === 'approved' && mod.doc.content ? {text:mod.doc.content,version:1} : null;
  }
  function cleanVerificationControls(mod, t) {
    const box = node('section', undefined, 'clean-verification-discussion');
    const busy=!!(t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy());
    const open = node('button', '讨论清洗核验', 'quiet-button'); open.type = 'button';
    open.setAttribute('aria-label','讨论清洗核验'); open.disabled = busy;
    open.onclick = () => {
      try { if (root.TaskManager?.openCleanVerificationDraft?.(mod.id,{standardNames:cleanStandardNames(mod.id)}) !== true) throw new Error('当前无法打开，请先结束任务或处理未保存的编辑。'); t.cleanAcceptanceError = ''; }
      catch (error) { t.cleanAcceptanceError = error.message; } render();
    };
    box.append(open, node('p','把人工标准直接粘贴到同一方案，或先提供原件，再讨论确认。自动检查与人工核验分别记录；本入口只讨论，不清洗或自动确认。','codex-status'));
    const standards=node('details',undefined,'clean-standard-attachments');standards.open=false;standards.append(node('summary','人工标准原件 · '+cleanStandardNames(mod.id).length+' 份（提供或查看）'));
    standards.append(node('p','上传只保留原件，不会自动采纳或签署通过。无法解析的内容请人工阅读原件，并把具体要求整理进方案。','codex-status'));
    const upload=node('input');upload.type='file';upload.multiple=true;upload.accept='.md,.txt,.pdf,.docx,.csv,.tsv,.xlsx,.xls,.json';upload.disabled=busy;upload.setAttribute('aria-label','提供人工核验标准文件');upload.onchange=()=>uploadCleanStandards(mod,Array.from(upload.files || []));standards.append(upload);
    cleanStandardNames(mod.id).forEach(name=>{
      const row=node('div',undefined,'clean-standard-file'),link=node('a','查看原件：'+name,'quiet-button');link.href='/api/codex/download?session='+encodeURIComponent(saved[mod.id]?.sessionId || '')+'&group=reference&name='+encodeURIComponent(name);row.append(link);
      const remove=node('button','移出本次标准','quiet-button');remove.type='button';remove.disabled=busy;remove.onclick=()=>{if(t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy())return;saved[mod.id]={...saved[mod.id],cleanStandardNames:cleanStandardNames(mod.id).filter(value=>value!==name)};delete saved[mod.id].cleanHandoff;Store.invalidateCleanAcceptance?.(mod.id,null,'人工标准原件已改变，请在同一方案核对确认');t.preparedCleanPlan=null;t.executeOnce=false;persist();render();};row.append(remove);standards.append(row);
    });
    if(t.cleanStandardNotice)standards.append(node('p',t.cleanStandardNotice,'codex-status'));
    if(t.cleanStandardError)standards.append(node('p',t.cleanStandardError,'codex-error'));
    box.append(standards);
    const basis = basisForClean(mod), plan = basis?.text || root.TaskManager?.rulesForModule(mod.id)?.draft || mod.doc?.content;
    if (plan && root.CleanVerificationRules) {
      const prepared=root.CleanExecutionPlan?.prepare(plan);
      const compiled = root.CleanVerificationRules.compile(prepared?.executionText || plan);
      const rules = Array.isArray(compiled.checks?.rules) ? compiled.checks.rules : [];
      const checks = [...rules, ...(Array.isArray(compiled.valueRules?.rules) ? compiled.valueRules.rules : [])];
      const auto = checks.filter(rule => rule.kind !== 'manual'), manual = checks.filter(rule => rule.kind === 'manual'), human=Array.isArray(compiled.manualChecks?.rules) ? compiled.manualChecks.rules : [];
      const detail = node('details'); detail.open = false;
      detail.append(node('summary','方案核验规则 · '+auto.length+' 项自动 · '+human.length+' 项人工 · '+manual.length+' 项需明确'));
      detail.append(node('p',basis ? '当前已确认方案；实际检查结果以本次执行后的核验报告为准。' : '当前草稿待确认；未应用为执行或验收依据。','codex-status'));
      if (!checks.length) detail.append(node('p','尚未整理成可执行规则；由智能体结合实际数据和方案补齐，不自行设定阈值。','codex-status'));
      checks.forEach(rule => detail.append(node('p',(rule.id || '规则')+' · '+(rule.label || rule.field || rule.target || '')+'：'+(rule.kind === 'manual' ? '需判断：'+(rule.reason || '待补依据') : '可自动核对')+'；依据：'+(rule.basis || '见方案'),'codex-status')));
      human.forEach(rule=>detail.append(node('p',(rule.id || '人工项')+' · '+rule.label+'：'+(rule.reason ? '需先补齐：'+rule.reason : (rule.required ? '必需人工核验' : '可选人工核验'))+'；方法：'+(rule.method || '待明确')+'；通过条件：'+(rule.condition || '待明确')+'；依据：'+(rule.basis || '待明确'),'codex-status')));
      box.append(detail);
    }
    return box;
  }
  function noteUnavailableCleanSession(id, sid, error) {
    const t=task(id);
    if (saved[id]?.sessionId!==sid || !['SESSION_NOT_FOUND','SESSION_INCOMPLETE'].includes(error?.code) || (error.sessionId && error.sessionId!==sid)) return false;
    t.cleanAcceptanceUnavailableSession=sid;
    t.cleanAcceptanceNotice='本机尚无可用的清洗执行记录；浏览器中的方案和历史关联已保留。可检查工作台位置或恢复原任务文件后刷新，这里不会自动新建任务或清洗。';
    t.cleanRuns=[];t.cleanRunsLoadedSession=sid;t.cleanAcceptance=null;t.cleanAcceptanceKey=null;t.cleanAcceptanceError='';t.cleanResultsError='';
    if (t.error && /任务不存在|SESSION_NOT_FOUND|SESSION_INCOMPLETE/.test(t.error)) t.error='';
    if (t.cleanAcceptancePollTimer) {clearTimeout(t.cleanAcceptancePollTimer);t.cleanAcceptancePollTimer=null;t.cleanAcceptancePollKey=null;}
    return true;
  }
  function cleanAcceptanceScope(mod) {
    const t = task(mod.id), sid = saved[mod.id]?.sessionId;
    if (t.cleanAcceptanceUnavailableSession && t.cleanAcceptanceUnavailableSession===sid) return null;
    const runId = t.cleanAcceptanceRunId || saved[mod.id]?.cleanAcceptanceRunId || t.cleanRuns?.[0]?.id;
    if (!sid || !runId || t.cleanRunsLoadedSession !== sid) return null;
    const run = (t.cleanRuns || []).find(item => item.id === runId);
    if (!run) return null;
    return {sessionId:sid,runId,run,key:JSON.stringify([sid,runId])};
  }
  function cleanStandardSelectionMatches(mod, run) {
    if(!run)return false;
    const frozen=Array.isArray(run.standardFiles) ? run.standardFiles.map(file=>file.name) : Array.isArray(run.standardNames) ? run.standardNames : [];
    return JSON.stringify(cleanStandardNames(mod.id).slice().sort())===JSON.stringify([...new Set(frozen)].sort());
  }
  function cleanAcceptanceReady(report) {
    return !!(report?.id && report.status === 'ready' && Array.isArray(report.checks) && Array.isArray(report.issues)
      && !report.issues.some(issue => issue.severity === 'error' || issue.resolution?.decision === 'reject' || (issue.decisionRequired && issue.resolution?.decision !== 'accept'))
      && !(report.manualChecks || []).some(check=>check.reason || check.resolution?.conclusion==='rejected' || (check.required && (check.resolution?.conclusion!=='passed' || !check.resolution.note?.trim() || !check.resolution.evidence?.trim() || !check.resolution.reviewer?.trim()))));
  }
  function cleanAcceptanceReport(mod, t) {
    const scope = cleanAcceptanceScope(mod);
    return scope && t.cleanAcceptanceKey === scope.key ? t.cleanAcceptance : null;
  }
  async function loadCleanAcceptanceRuns(id, force = false, completedRunId = null) {
    const t = task(id), sid = saved[id]?.sessionId;
    if (!sid || t.cleanRunsLoading || (!force && t.cleanRunsLoadedSession === sid)) return;
    if (root.TaskManager?.applyCleanRuleUpdate) {
      try { await syncCleanRuleUpdate(id); } catch(error) { if(error.code!=='CLEAN_SYNC_CONTEXT_CHANGED')t.cleanRuleSyncError=error.message; }
      if (saved[id]?.sessionId!==sid || t.cleanRunsLoading) return;
    }
    const generation = (t.cleanRunsGeneration || 0) + 1; t.cleanRunsGeneration = generation; t.cleanRunsLoading = true;
    try {
      const data = await request('/api/codex/clean/runs?session='+encodeURIComponent(sid));
      if (saved[id]?.sessionId !== sid || t.cleanRunsGeneration !== generation) return;
      t.cleanRuns = Array.isArray(data.runs) ? data.runs : []; t.cleanRunsLoadedSession = sid; t.cleanAcceptanceError = ''; t.cleanAcceptanceUnavailableSession=null;t.cleanAcceptanceNotice='';
      const selected = [completedRunId,t.cleanAcceptanceRunId,saved[id]?.cleanAcceptanceRunId].find(value=>value && t.cleanRuns.some(run=>run.id===value)) || t.cleanRuns[0]?.id || null;
      t.cleanAcceptanceRunId = selected;
      if (saved[id]?.cleanAcceptanceRunId !== (selected || undefined)) {
        if (selected) saved[id].cleanAcceptanceRunId = selected;
        else delete saved[id].cleanAcceptanceRunId;
        persist();
      }
      if (!selected || t.cleanAcceptanceKey !== JSON.stringify([sid,selected])) {
        t.cleanAcceptance = null; t.cleanAcceptanceKey = null; t.cleanAcceptanceLoadedKey = null;
      }
      const mod = Store.getState().modules.find(item=>item.id === id);
      // Recover an explicit A-plan data binding after a server-side execution or
      // refresh, without editing the approved text or any discussion history.
      const run = t.cleanRuns.find(item=>item.id===selected), basis=mod && basisForClean(mod);
      const prepared=basis && root.CleanExecutionPlan?.prepare(basis.text);
      if (run && prepared && run.planText===basis.text && run.executionAdapter===prepared.adapter && Array.isArray(run.inputFiles)) {
        const names=run.inputFiles.map(file=>file.name), standards=cleanStandardNames(id).filter(name=>!prepared.inputReferenceNames.includes(name));
        if (prepared.inputReferenceNames.every(name=>names.includes(name)) && JSON.stringify(standards.slice().sort())===JSON.stringify((run.standardFiles || []).map(file=>file.name).sort())) {
          saved[id]={...saved[id],cleanStandardNames:standards,inputBatch:{...(saved[id]?.inputBatch || {}),names,label:'已确认规则指定的原始数据',text:'原件保留，SHA-256一致的输入副本已绑定。'}};
          persist();
        }
      }
      if (mod && selected) await loadCleanAcceptance(mod, false, true);
    } catch (error) {
      if (saved[id]?.sessionId === sid && t.cleanRunsGeneration === generation) {
        t.cleanRunsLoadedSession=sid;
        if (!noteUnavailableCleanSession(id,sid,error)) t.cleanAcceptanceError='无法读取清洗核验记录：'+error.message+'。可点击“刷新核验记录”重试，原方案和文件关联保留。';
      }
    }
    finally { if (t.cleanRunsGeneration === generation) { t.cleanRunsLoading = false; render(); } }
  }
  function queueCleanAcceptancePoll(mod) {
    const t=task(mod.id),scope=cleanAcceptanceScope(mod),report=cleanAcceptanceReport(mod,t);
    const current=Store.getState().modules.find(item=>item.id===mod.id);
    if (t.cleanAcceptancePollTimer && (!scope || t.cleanAcceptancePollKey!==scope.key || report?.status!=='checking' || !current || Store.getState().activeModuleId!==mod.id)) {
      clearTimeout(t.cleanAcceptancePollTimer);t.cleanAcceptancePollTimer=null;t.cleanAcceptancePollKey=null;
    }
    if (!scope || !current || Store.getState().activeModuleId!==mod.id || report?.status!=='checking' || t.cleanAcceptancePollTimer) return;
    const key=scope.key;t.cleanAcceptancePollKey=key;
    t.cleanAcceptancePollTimer=setTimeout(async()=>{
      t.cleanAcceptancePollTimer=null;t.cleanAcceptancePollKey=null;
      const state=Store.getState(),currentMod=state.modules.find(item=>item.id===mod.id);
      if (!currentMod || state.activeModuleId!==mod.id || cleanAcceptanceScope(mod)?.key!==key || cleanAcceptanceReport(mod,t)?.status!=='checking') return;
      if (!t.busy && !t.cleanAcceptanceBusy && !t.cleanAcceptanceLoading && !root.ModuleSpace?.isBusy()) await loadCleanAcceptance(currentMod);
      queueCleanAcceptancePoll(currentMod);
    },1500);
  }
  async function loadCleanAcceptance(mod, verify = false, internal = false) {
    const t = task(mod.id), scope = cleanAcceptanceScope(mod);
    if (!scope || t.cleanAcceptanceLoading || t.cleanAcceptanceBusy || (!internal && (t.busy || root.ModuleSpace?.isBusy()))) return null;
    const generation = (t.cleanAcceptanceGeneration || 0)+1; t.cleanAcceptanceGeneration = generation;
    t.cleanAcceptanceLoading = true; t.cleanAcceptanceError = ''; render();
    try {
      const report = verify ? await request('/api/codex/clean/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:scope.sessionId,runId:scope.runId,confirm:true})})
        : await request('/api/codex/clean/verification?session='+encodeURIComponent(scope.sessionId)+'&run='+encodeURIComponent(scope.runId));
      if (cleanAcceptanceScope(mod)?.key !== scope.key || t.cleanAcceptanceGeneration !== generation) return null;
      if (!report || (report.runId && report.runId !== scope.runId)) throw new Error('核验报告与当前运行不匹配，请刷新记录。');
      t.cleanAcceptance = report; t.cleanAcceptanceKey = scope.key; t.cleanAcceptanceLoadedKey = scope.key; queueCleanAcceptancePoll(mod); return report;
    } catch (error) { if (cleanAcceptanceScope(mod)?.key === scope.key && t.cleanAcceptanceGeneration === generation && !noteUnavailableCleanSession(mod.id,scope.sessionId,error)) t.cleanAcceptanceError = error.message; return null; }
    finally { if (t.cleanAcceptanceGeneration === generation) { t.cleanAcceptanceLoading = false; render(); } }
  }
  async function decideCleanAcceptance(mod, reportId, issueId, decision, note) {
    const t = task(mod.id), scope = cleanAcceptanceScope(mod), report = cleanAcceptanceReport(mod,t);
    if (!scope || t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy()) return false;
    const issue = report?.id === reportId && report.issues?.find(value => value.id === issueId);
    if (!issue || issue.resolution || !['accept','reject'].includes(decision) || (decision === 'accept' && !(issue.severity === 'warning' && issue.canAccept === true && issue.decisionRequired))) {
      t.cleanAcceptanceError = '本项已变化或不能接受，请刷新报告后处理。'; render(); return false;
    }
    if (typeof note !== 'string' || !note.trim()) { t.cleanAcceptanceError = '请填写本次决定的理由和依据。'; render(); return false; }
    t.cleanAcceptanceBusy = true; t.cleanAcceptanceError = ''; render();
    try {
      const next = await request('/api/codex/clean/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:scope.sessionId,runId:scope.runId,reportId,issueId,decision,note:note.trim()})});
      if (cleanAcceptanceScope(mod)?.key !== scope.key) throw new Error('运行版本已改变，决定未应用到当前页面。');
      t.cleanAcceptance = next; t.cleanAcceptanceKey = scope.key; return true;
    } catch(error) { t.cleanAcceptanceError = error.message; return false; }
    finally { t.cleanAcceptanceBusy = false; render(); }
  }
  function cleanAcceptanceArtifact(mod, artifact, label) {
    return downloadAcceptanceArtifact(mod, artifact, label);
  }
  async function recordCleanManualCheck(mod, reportId, checkId, conclusion, note, evidence, reviewer) {
    const t=task(mod.id),scope=cleanAcceptanceScope(mod),report=cleanAcceptanceReport(mod,t),basis=basisForClean(mod),projectId=root.TaskManager?.currentTaskId?.();
    if(!scope || t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy())return false;
    const check=report?.id===reportId && report.manualChecks?.find(value=>value.id===checkId);
    if(!check || !scope.run?.planText || basis?.text!==scope.run.planText || !cleanStandardSelectionMatches(mod,scope.run) || ['not_checked','checking'].includes(report.status)) {t.cleanAcceptanceError='人工核验项、方案、标准原件或报告已变化，请刷新核对后记录。';render();return false;}
    if(!['passed','rejected','needs_evidence'].includes(conclusion) || (conclusion==='passed' && check.reason)) {t.cleanAcceptanceError='此标准尚未明确，请回到同一方案补齐并确认，不能直接签署通过。';render();return false;}
    if(typeof note!=='string' || !note.trim() || typeof reviewer!=='string' || !reviewer.trim() || (conclusion==='passed' && (typeof evidence!=='string' || !evidence.trim()))) {t.cleanAcceptanceError='请填写核验人、理由；通过还须记录实际核对位置和证据，标准来源不能代替核验证据。';render();return false;}
    if(note.length>2000 || String(evidence || '').length>4000 || reviewer.length>120) {t.cleanAcceptanceError='核验记录过长，请精简理由、证据或核验人信息。';render();return false;}
    t.cleanAcceptanceBusy=true;t.cleanAcceptanceError='';render();
    try {
      const next=await request('/api/codex/clean/manual-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:scope.sessionId,runId:scope.runId,reportId,checkId,conclusion,note:note.trim(),evidence:String(evidence || '').trim(),reviewer:reviewer.trim(),rulesText:basis.text,standardNames:cleanStandardNames(mod.id)})});
      if(cleanAcceptanceScope(mod)?.key!==scope.key || (projectId && root.TaskManager?.currentTaskId?.()!==projectId) || !Store.getState().modules.some(value=>value.id===mod.id && value.type==='clean-data') || basisForClean(mod)?.text!==basis.text || !cleanStandardSelectionMatches(mod,scope.run))throw new Error('项目、方案、标准原件或运行已变化；记录保留在原报告，未应用到当前页面。');
      if(next.id!==reportId || next.runId!==scope.runId)throw new Error('返回的人工核验记录与当前报告不匹配，请刷新。');
      t.cleanAcceptance=next;t.cleanAcceptanceKey=scope.key;t.cleanManualDrafts ||= {};t.cleanManualDrafts[reportId+':'+checkId]={note:note.trim(),evidence:String(evidence || '').trim(),reviewer:reviewer.trim()};
      saved[mod.id]={...saved[mod.id],cleanReviewerName:reviewer.trim()};delete saved[mod.id].cleanHandoff;Store.invalidateCleanAcceptance?.(mod.id,scope.runId,'人工核验结论已更新，需重新确认后交接');persist();return true;
    }catch(error){t.cleanAcceptanceError=error.message;return false;}
    finally{t.cleanAcceptanceBusy=false;render();}
  }
  function cleanManualCheckPanel(mod,t,report,busy) {
    const section=node('section',undefined,'clean-manual-checks');section.setAttribute('aria-label','人工核验标准与记录');
    const checks=Array.isArray(report.manualChecks) ? report.manualChecks : [];
    if(!checks.length)return section;
    section.append(node('h4','人工核验标准与记录'),node('p','请按已确认标准检查实际结果，再记录结论。这里的人工通过单独留档，不会把自动检查改成通过；必需项未通过不能交给计算。','codex-status'));
    const current=basisForClean(mod),scope=cleanAcceptanceScope(mod),locked=busy || !scope?.run?.planText || current?.text!==scope.run.planText || !cleanStandardSelectionMatches(mod,scope.run) || ['checking','not_checked'].includes(report.status);
    const completed=node('details',undefined,'download-acceptance-normal');completed.open=false;completed.append(node('summary','已完成的人工核验（展开查看或修改）'));
    checks.forEach(check=>{
      const resolution=check.resolution,passed=!check.reason && resolution?.conclusion==='passed',item=node('details',undefined,'clean-manual-check');item.open=!passed && (check.required || !!resolution);
      item.setAttribute('aria-label','人工核验 '+check.id);
      const status={passed:'人工核验通过',rejected:'已退回',needs_evidence:'待补证据'}[resolution?.conclusion] || '待人工核验';
      item.append(node('summary',(check.required ? '必需' : '可选')+' · '+(check.label || check.id)+' · '+status));
      item.append(node('p','检查方法：'+(check.method || '待明确')),node('p','通过条件：'+(check.condition || '待明确')),node('p','标准依据：'+(check.basis || '待明确'),'codex-status'));
      (Array.isArray(scope?.run?.standardFiles) ? scope.run.standardFiles.map(file=>file.name) : cleanStandardNames(mod.id)).filter(name=>[check.basis,check.sourceText].filter(Boolean).join('\n').includes(name)).forEach(name=>{const link=node('a','查看标准原件：'+name,'quiet-button');link.href='/api/codex/download?session='+encodeURIComponent(saved[mod.id]?.sessionId || '')+'&group=reference&name='+encodeURIComponent(name);item.append(link);});
      if(check.reason)item.append(node('p','标准尚需完善：'+check.reason+'。请回同一清洗方案补齐并确认，不能直接签署通过。','codex-error'));
      if(resolution)item.append(node('p','当前结论：'+status+'；核验人：'+(resolution.reviewer || '未记录')+'；时间：'+(resolution.at || '未记录')),node('p','理由：'+resolution.note),node('p','实际核验证据：'+(resolution.evidence || '尚待补充')));
      t.cleanManualDrafts ||= {};const key=report.id+':'+check.id,draft=t.cleanManualDrafts[key] ||= {note:resolution?.note || '',evidence:resolution?.evidence || '',reviewer:resolution?.reviewer || saved[mod.id]?.cleanReviewerName || '研究者'};
      const form=node('div',undefined,'clean-manual-fields'),note=node('textarea'),evidence=node('textarea'),reviewer=node('input');
      note.rows=2;note.maxLength=2000;note.placeholder='说明检查结果及通过、退回或待补的理由';note.setAttribute('aria-label','人工核验理由 '+check.id);note.value=draft.note;note.disabled=locked;
      evidence.rows=3;evidence.maxLength=4000;evidence.placeholder='记录实际核对位置和观察，例如原表第3页与结果第12—16行；引用标准文件本身不等于已检查结果';evidence.setAttribute('aria-label','人工核验证据 '+check.id);evidence.value=draft.evidence;evidence.disabled=locked;
      reviewer.type='text';reviewer.maxLength=120;reviewer.setAttribute('aria-label','人工核验人 '+check.id);reviewer.value=draft.reviewer;reviewer.disabled=locked;
      [['理由',note],['实际核对位置与证据',evidence],['核验人（可修改）',reviewer]].forEach(([label,field])=>{const wrap=node('label',label);wrap.append(field);form.append(wrap);});item.append(form);
      const buttons=node('div',undefined,'codex-toolbar'),actions=[];
      [['passed','人工核验通过'],['rejected','退回处理'],['needs_evidence','待补证据']].forEach(([conclusion,label])=>{const button=node('button',label,'quiet-button');button.type='button';button.onclick=()=>recordCleanManualCheck(mod,report.id,check.id,conclusion,note.value,evidence.value,reviewer.value);buttons.append(button);actions.push([conclusion,button]);});
      const update=()=>{draft.note=note.value;draft.evidence=evidence.value;draft.reviewer=reviewer.value;actions.forEach(([conclusion,button])=>{button.disabled=locked || !note.value.trim() || !reviewer.value.trim() || (conclusion==='passed' && (!!check.reason || !evidence.value.trim()));});};note.oninput=update;evidence.oninput=update;reviewer.oninput=update;update();item.append(buttons);
      if(check.history?.length){const history=node('details');history.open=false;history.append(node('summary','历次人工核验记录 · '+check.history.length+' 条'));check.history.forEach(entry=>history.append(node('p',({passed:'通过',rejected:'退回',needs_evidence:'待补证据'}[entry.conclusion] || entry.conclusion)+'；'+(entry.reviewer || '')+'；'+(entry.at || '')+'；理由：'+(entry.note || '')+'；证据：'+(entry.evidence || '无'))));item.append(history);}
      if(passed)completed.append(item);else section.append(item);
    });
    if(checks.some(check=>!check.reason && check.resolution?.conclusion==='passed'))section.append(completed);
    return section;
  }
  function cleanAcceptancePanel(mod,t) {
    const box = node('section', undefined, 'download-acceptance-card clean-acceptance-card'); box.setAttribute('aria-label','清洗核验与待处理问题');
    box.append(node('h3','清洗核验与待处理问题'));
    if (saved[mod.id]?.sessionId && !t.busy && !t.cleanRunsLoading && t.cleanRunsLoadedSession !== saved[mod.id].sessionId && !t.cleanRunsQueued) {
      t.cleanRunsQueued = true; void Promise.resolve().then(()=>{ t.cleanRunsQueued = false; return loadCleanAcceptanceRuns(mod.id); });
    }
    queueCleanAcceptancePoll(mod);
    const scope = cleanAcceptanceScope(mod), report = cleanAcceptanceReport(mod,t), busy = !!(t.busy || t.cleanRunsLoading || t.cleanAcceptanceLoading || t.cleanAcceptanceBusy || root.ModuleSpace?.isBusy());
    const runs = t.cleanRuns || [];
    if (runs.length) {
      const label = node('label','核验哪次清洗 '), select = node('select'); select.setAttribute('aria-label','核验哪次清洗');
      runs.forEach((run,index)=>{ const option=node('option',(index === 0 ? '最新 · ' : '历史 · ')+(run.planVersion ? '方案 v'+run.planVersion+' · ' : '旧版未冻结方案 · ')+new Date(run.createdAt || run.updatedAt).toLocaleString('zh-CN')+' · '+run.id.slice(0,8)); option.value=run.id; select.append(option); });
      select.value=scope?.runId || ''; select.disabled=busy;
      select.onchange=()=>{ t.cleanAcceptanceRunId=select.value; t.cleanAcceptance=null; t.cleanAcceptanceKey=null; saved[mod.id]={...saved[mod.id],cleanAcceptanceRunId:select.value}; persist(); void loadCleanAcceptance(mod); render(); }; label.append(select); box.append(label);
    }
    const labels={ready:'核验已就绪，仍待本次统一确认',needs_decision:'有问题需要你决定',needs_manual:'必需人工核验尚未通过，请查看下面的标准和记录',blocked:'存在阻断问题，处理后重新核验',rejected:'已退回处理，尚不能交接',checking:'正在核验已有清洗结果',not_checked:'尚未核验，不表示通过'};
    box.append(node('p',busy ? '正在读取或核验现有结果；不会重复清洗。' : t.cleanAcceptanceUnavailableSession && t.cleanAcceptanceUnavailableSession===saved[mod.id]?.sessionId ? t.cleanAcceptanceNotice : report ? labels[report.status] || '请查看本次核验记录。' : scope ? '已有结果尚未核验；旧文件与原结果保留，不自动重做。' : '暂无清洗执行记录。先讨论并确认方案，执行后再核验。','codex-status'));
    const toolbar=node('div',undefined,'codex-toolbar');
    const verify=node('button','核验已有清洗结果','quiet-button'); verify.type='button'; verify.disabled=!scope || busy; verify.onclick=()=>loadCleanAcceptance(mod,true); toolbar.append(verify);
    const refresh=node('button','刷新核验记录','quiet-button'); refresh.type='button'; refresh.disabled=!saved[mod.id]?.sessionId || busy; refresh.onclick=()=>loadCleanAcceptanceRuns(mod.id,true); toolbar.append(refresh); box.append(toolbar);
    if (report && Array.isArray(report.checks) && Array.isArray(report.issues)) {
      const counts=[['inputRows','输入记录'],['cleanedRows','结果记录'],['pendingRows','待处理记录'],['duplicateRows','去重记录'],['excludedRows','排除记录'],['changedCells','改值'],['openDecisions','待决定问题'],['manualRequiredPending','必需人工待核验']].filter(([key])=>Number.isFinite(report.summary?.[key])).map(([key,label])=>label+' '+report.summary[key]);
      if(counts.length) box.append(node('p',counts.join(' · '),'codex-status'));
      const normal=node('details',undefined,'download-acceptance-normal'); normal.open=false; normal.append(node('summary','正常检查与已记录决定（展开查看）'));
      report.checks.forEach(check=>normal.append(node('p',(check.label || check.id)+' · '+({passed:'通过',failed:'未通过',pending:'待判断',limited:'检查有限'}[check.status] || check.status || '')+(check.evidence ? '；'+(typeof check.evidence==='string' ? check.evidence : JSON.stringify(check.evidence)) : ''),'codex-status')));
      report.issues.filter(issue=>issue.severity!=='error' && issue.resolution?.decision==='accept').forEach(issue=>normal.append(node('p',(issue.title || issue.id)+'：已接受本次例外；理由：'+issue.resolution.note,'codex-status'))); box.append(normal);
      report.issues.filter(issue=>issue.severity==='error' || (issue.resolution?.decision!=='accept' && (issue.decisionRequired || issue.resolution?.decision==='reject'))).forEach(issue=>{
        const item=node('section',undefined,'download-acceptance-issue'); item.setAttribute('aria-label','清洗待处理问题 '+issue.id);
        item.append(node('h4','问题：'+(issue.title || issue.id)),node('p','影响：'+(issue.impact || '见记录定位和报告。')));
        const evidence=node('details'); evidence.open=false; evidence.append(node('summary','查看原值、结果、依据与已尝试的处理'));
        (Array.isArray(issue.evidence) ? issue.evidence : []).forEach(value=>{ evidence.append(node('p',typeof value==='string' ? value : [value.label,value.detail].filter(Boolean).join('：'))); const link=cleanAcceptanceArtifact(mod,value.artifact); if(link)evidence.append(link); });
        evidence.append(node('p','已尝试：'+((issue.attempts || []).map(value=>typeof value==='string' ? value : [value.label,value.detail,value.outcome].filter(Boolean).join('；')).join('；') || '尚无已记录的处理尝试。'),'codex-status')); item.append(evidence,node('p','建议：'+(issue.recommendation || '核对并修正后重新核验。')));
        if(issue.resolution?.decision==='reject') item.append(node('p','已退回：'+issue.resolution.note,'codex-error'));
        else {
          item.append(node('p',issue.severity==='error' ? '此项不能强行接受，需修复后重新核验。' : issue.decisionPrompt || '需要你决定是否接受本次例外。','codex-status'));
          const note=node('textarea'); note.rows=2; note.maxLength=2000; note.placeholder='写明依据和本次决定理由'; note.setAttribute('aria-label','清洗决定理由 '+issue.id); note.disabled=busy;
          t.cleanAcceptanceNotes ||= {}; const noteKey=report.id+':'+issue.id; note.value=t.cleanAcceptanceNotes[noteKey] || ''; note.oninput=()=>{t.cleanAcceptanceNotes[noteKey]=note.value;}; item.append(note);
          if(issue.severity==='warning' && issue.canAccept===true && issue.decisionRequired) {const accept=node('button','接受本次例外','quiet-button');accept.type='button';accept.disabled=busy;accept.onclick=()=>decideCleanAcceptance(mod,report.id,issue.id,'accept',note.value);item.append(accept);}
          const reject=node('button','退回处理','quiet-button'); reject.type='button';reject.disabled=busy;reject.onclick=()=>decideCleanAcceptance(mod,report.id,issue.id,'reject',note.value);item.append(reject);
        } box.append(item);
      });
      box.append(cleanManualCheckPanel(mod,t,report,busy));
      const files=node('details');files.open=false;files.append(node('summary','完整核验报告与逐条依据')); (report.artifacts || []).forEach(artifact=>{const link=cleanAcceptanceArtifact(mod,artifact);if(link)files.append(link);});box.append(files);
    }
    const currentBasis=basisForClean(mod), samePlan=!!(scope?.run?.planText && currentBasis?.text===scope.run.planText && cleanStandardSelectionMatches(mod,scope.run));
    if(scope && !samePlan)box.append(node('p','当前方案或标准原件与本次冻结记录不一致，或原结果缺少冻结记录。原文件保留；新标准请在同一方案补齐确认，不能直接套用旧核验通过。','codex-status'));
    const confirm=node('button',scope && saved[mod.id]?.cleanHandoff?.runId === scope.runId ? '查看已交接的计算模块' : '确认结果并交给计算','primary-button');confirm.type='button';confirm.disabled=busy || !samePlan || !cleanAcceptanceReady(report);confirm.onclick=()=>confirmCleanAcceptance(mod.id);box.append(confirm);
    if(t.cleanAcceptanceError)box.append(node('p',t.cleanAcceptanceError,'codex-error'));
    return box;
  }
  async function confirmCleanAcceptance(id) {
    const mod=Store.getState().modules.find(item=>item.id===id),t=task(id);
    if(!mod || mod.type!=='clean-data' || t.busy || t.cleanAcceptanceBusy || t.cleanAcceptanceLoading || root.ModuleSpace?.isBusy()) return false;
    const projectId=root.TaskManager?.currentTaskId?.();let expected=null;
    function assertContext(targetId) {
      const state=Store.getState();
      if (!state.modules.some(item=>item.id===id && item.type==='clean-data') || (projectId && root.TaskManager?.currentTaskId?.()!==projectId) || (targetId && !state.modules.some(item=>item.id===targetId && item.type==='calculation'))) throw new Error('工作台项目或模块已经变化，未继续交接；原清洗结果保留。');
      if(expected && (cleanAcceptanceScope(mod)?.key!==expected.scope.key || basisForClean(mod)?.text!==expected.text || !cleanStandardSelectionMatches(mod,expected.scope.run)))throw new Error('方案、标准原件或运行已变化，未继续交接；原清洗结果保留。');
    }
    try {
      assertContext();
      const scope=cleanAcceptanceScope(mod),basis=basisForClean(mod);
      if(!scope?.run || !basis || basis.text!==scope.run.planText || !cleanStandardSelectionMatches(mod,scope.run))throw new Error('请先选择与当前已确认方案及标准原件一致的清洗运行；新标准需纳入同一方案，旧结果保留，不自动重做。');
      expected={scope,text:basis.text};
      const previous=saved[id]?.cleanHandoff;
      const delivered=previous?.runId===scope.runId && Store.getState().modules.find(item=>item.id===previous.targetModuleId);
      if(delivered){ Store.selectModule(delivered.id); return true; }
      const report=await loadCleanAcceptance(mod,true);
      assertContext();
      if(!cleanAcceptanceReady(report))throw new Error(t.cleanAcceptanceError || '本次核验未就绪，请先处理待决定或阻断问题。');
      if(cleanAcceptanceScope(mod)?.key!==scope.key || basisForClean(mod)?.text!==basis.text || !cleanStandardSelectionMatches(mod,scope.run))throw new Error('核验期间方案、标准原件或运行变化，未交接。');
      t.cleanAcceptanceBusy=true;t.error='';render();
      const accepted=await request('/api/codex/clean/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:scope.sessionId,runId:scope.runId,reportId:report.id,rulesText:basis.text,confirm:true})});
      assertContext();
      if(!accepted.confirmed || !Array.isArray(accepted.cleanedNames) || !accepted.cleanedNames.length)throw new Error('后台未确认本次清洗结果，未创建下游输入。');
      if(cleanAcceptanceScope(mod)?.key!==scope.key || basisForClean(mod)?.text!==basis.text || !cleanStandardSelectionMatches(mod,scope.run))throw new Error('确认后方案、标准原件或运行变化，未交接。');
      assertContext();
      let calculation=Store.getState().modules.find(item=>item.type==='calculation');
      if(!calculation){Store.addModule('模型调整与计算');calculation=Store.getState().modules.find(item=>item.type==='calculation');}
      if(!calculation)throw new Error('未找到计算模块；验收记录和结果已保留。');
      const target=await session(calculation.id);
      assertContext(calculation.id);
      const result=await request('/api/codex/import-input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:target,sourceSessionId:scope.sessionId,names:accepted.cleanedNames,sourceGroup:'output',confirm:true,cleanRunId:scope.runId,cleanReportId:report.id})});
      assertContext(calculation.id);
      task(calculation.id).files=result.files;task(calculation.id).filesOpen=true;
      saved[calculation.id]={...saved[calculation.id],inputBatch:{names:result.names,label:'已验收清洗结果',text:basis.text,cleanAcceptance:{runId:scope.runId,reportId:report.id,planSha256:report.planSha256,planText:basis.text}}};
      scope.run.acceptanceConfirmed=accepted; saved[id]={...saved[id],cleanHandoff:{runId:scope.runId,reportId:report.id,targetModuleId:calculation.id}};persist();
      const marked=Store.markRun(id,{dir:scope.runId,artifacts:accepted.cleanedNames.map(name=>({name,size:0})),cleanAcceptance:{runId:scope.runId,reportId:report.id,planSha256:report.planSha256,planText:basis.text}});
      if(!marked || !Store.confirmRun(id))throw new Error('文件已交接，但本环节确认记录未保存，请刷新核验记录。');
      Store.appendMessage(id,'已确认本次清洗结果并交给计算；核验报告与决定留档。没有启动计算。','system');
      Store.appendMessage(calculation.id,'已接收清洗运行 '+scope.runId+' 的 '+result.names.length+' 个已核验结果文件。报告：'+report.id+'。先讨论并确认计算方案，再执行计算。','system');
      Store.approveModule(id);Store.selectModule(calculation.id);return true;
    }catch(error){t.cleanAcceptanceError=error.message;return false;}
    finally{t.cleanAcceptanceBusy=false;render();ModuleSpace.render();}
  }
  async function loadCleanResults(id, runId) {
    const t = task(id), generation = (t.cleanResultsGeneration || 0) + 1;
    t.cleanResultsGeneration = generation; t.cleanResultsLoading = true; t.cleanResultsError = '';
    try {
      const sid = await session(id);
      const data = await request('/api/codex/clean-results?session=' + encodeURIComponent(sid) + (runId ? '&run=' + encodeURIComponent(runId) : ''));
      if (t.cleanResultsGeneration === generation) t.cleanResults = data;
    } catch (error) { if (t.cleanResultsGeneration === generation) t.cleanResultsError = '无法整理清洗结果：' + error.message; }
    finally { if (t.cleanResultsGeneration === generation) { t.cleanResultsLoading = false; render(); } }
  }
  function cleanResultLink(id, file) {
    const link = node('a', undefined, 'clean-result-file');
    link.title = file.name;
    link.setAttribute('aria-label', (file.label || '文件') + '：' + file.name.split('/').pop());
    link.href = '/api/codex/download?session=' + encodeURIComponent(saved[id]?.sessionId || '') + '&group=' + file.group + '&name=' + encodeURIComponent(file.name);
    link.append(node('strong', file.label || file.name.split('/').pop()));
    link.append(node('span', file.name.split('/').pop() + ' · ' + Math.ceil(file.size / 1024) + 'KB' + (Number.isInteger(file.rowCount) ? ' · ' + file.rowCount.toLocaleString() + ' 行' : ''), 'clean-result-meta'));
    return link;
  }
  function cleanInputSelection(id) {
    const all = task(id).files.filter(f => f.group === 'input' && /\.(csv|tsv|xlsx|xls)$/i.test(f.name));
    const previous = saved[id]?.cleanInputs;
    if (Array.isArray(previous)) return previous.filter(e => all.some(f => f.name === e.name));
    const batch = saved[id]?.inputBatch;
    return all.filter(f => !batch || batch.names.includes(f.name)).map(f => ({ name: f.name, encoding: 'utf-8-sig', sheets: null }));
  }
  function cleaningPanel(mod, t) {
    const section = node('details', undefined, 'clean-result-aux'); section.open = !!t.cleanSettingsOpen;
    const chosen = cleanInputSelection(mod.id);
    section.append(node('summary', '数据检查与处理范围 · ' + chosen.length + ' 个文件'));
    section.ontoggle = () => { if (section.isConnected) t.cleanSettingsOpen = section.open; };
    const change = entries => { t.cleanSettingsOpen = section.open; saved[mod.id] = { ...saved[mod.id], cleanInputs: entries }; persist(); t.cleanProfile = null; render(); };
    t.files.filter(f => f.group === 'input' && /\.(csv|tsv|xlsx|xls)$/i.test(f.name)).forEach(file => {
      const row = node('div', undefined, 'codex-toolbar'), label = node('label');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = chosen.some(e => e.name === file.name); checkbox.disabled = t.busy;
      checkbox.onchange = () => change(checkbox.checked ? [...chosen, {name:file.name, encoding:'utf-8-sig', sheets:null}] : chosen.filter(e => e.name !== file.name));
      label.append(checkbox, node('span', file.name.replace(/^[a-f0-9]{8}-/, ''))); row.append(label);
      const entry = chosen.find(e => e.name === file.name);
      if (entry && /\.(csv|tsv)$/i.test(file.name)) {
        const encoding = node('select'); encoding.setAttribute('aria-label', file.name + ' 文本编码');
        [['utf-8-sig','UTF-8'],['utf-16','UTF-16'],['gb18030','GB18030']].forEach(([value,label]) => { const option = node('option',label); option.value=value; encoding.append(option); });
        encoding.value = entry.encoding; encoding.disabled = t.busy;
        encoding.onchange = () => change(chosen.map(e => e.name === file.name ? {...e,encoding:encoding.value} : e)); row.append(encoding);
      }
      const sheets = t.cleanSheetCatalog?.[file.name];
      if (entry && sheets) {
        const select = node('select'); select.multiple = true; select.size = Math.min(4, sheets.length + 1); select.disabled = t.busy;
        select.setAttribute('aria-label', file.name + ' 选择工作表');
        ['*', ...sheets].forEach(name => { const option=node('option', name==='*'?'全部工作表':name); option.value=name; option.selected=entry.sheets ? entry.sheets.includes(name) : name==='*'; select.append(option); });
        select.onchange = () => { const values=Array.from(select.selectedOptions).map(o=>o.value); change(chosen.map(e=>e.name===file.name?{...e,sheets:values.includes('*')?null:values}:e)); }; row.append(select);
      }
      section.append(row);
    });
    const inspect = node('button', '检查所选数据', 'quiet-button'); inspect.type='button'; inspect.disabled=t.busy || !chosen.length;
    inspect.onclick = async () => {
      t.busy=true; t.error=''; render();
      try {
        t.cleanProfile = await request('/api/codex/cleaning/profile', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:await session(mod.id),inputs:cleanInputSelection(mod.id)})});
        t.cleanSheetCatalog = Object.fromEntries(t.cleanProfile.inputs.filter(e=>e.available_sheets).map(e=>[e.name,e.available_sheets]));
      } catch(error) { t.error=error.message; } finally { t.busy=false; t.cleanSettingsOpen=true; render(); }
    };
    section.append(inspect, node('p','固定程序完整检查所选表；Excel公式只读保存值，表头或缓存有歧义时列出问题。','clean-result-meta'));
    if(t.cleanProfile) {
      const profile=t.cleanProfile; section.append(node('p',profile.tables.length+' 张表、'+profile.row_count+' 条记录 · '+(profile.blocked?'有问题需先处理':'结构检查完成，处理规则仍需确认'),'codex-status'));
      const summary=node('details'); summary.append(node('summary','查看字段、空值、重复和数值检查'));
      summary.append(node('pre',JSON.stringify(profile.tables,null,2))); section.append(summary);
    }
    if(t.job?.stage) section.append(node('p','清洗阶段：'+({preparing:'准备',profiling:'数据检查',generating:'生成脚本',executing:'执行冻结脚本',verifying:'独立核验',completed:'完成'}[t.job.stage]||t.job.stage),'codex-status'));
    panel.append(section);
  }
  function renderCleanResults(mod, t, list) {
    list.classList.add('clean-results');
    if (t.cleanAcceptanceUnavailableSession && t.cleanAcceptanceUnavailableSession===saved[mod.id]?.sessionId) { list.append(node('p',t.cleanAcceptanceNotice,'codex-status')); return; }
    const key = JSON.stringify(t.files.map(file => [file.group, file.name, file.size]));
    if (saved[mod.id]?.sessionId && !t.cleanResultsLoading && t.cleanResultsKey !== key && (!t.busy || t.job?.status === 'completed')) {
      t.cleanResultsKey = key; loadCleanResults(mod.id, t.cleanResultsRunId);
    }
    if (t.cleanResultsLoading) list.append(node('p', '正在整理结果文件…', 'codex-status'));
    if (t.cleanResultsError) {
      list.append(node('p', t.cleanResultsError, 'codex-error'));
      const retry = node('button', '重新整理结果', 'quiet-button'); retry.type = 'button'; retry.onclick = () => { t.cleanResultsKey = null; render(); }; list.append(retry);
    }
    const view = t.cleanResults;
    if (!view) return;
    if (view.runId) {
      const heading = node('div', undefined, 'clean-result-heading');
      const select = node('select'); select.setAttribute('aria-label', '查看哪次清洗结果');
      view.runs.forEach((run, index) => { const option = node('option', (index === 0 ? '最新结果 · ' : '历史结果 · ') + new Date(run.updatedAt).toLocaleString('zh-CN') + ' · ' + run.id.slice(0, 8)); option.value = run.id; select.append(option); });
      select.value = view.runId; select.disabled = !!t.cleanResultsLoading;
      select.onchange = () => { t.cleanResultsRunId = select.value; loadCleanResults(mod.id, select.value); render(); };
      const bundle = node('a', '打包下载本次结果', 'quiet-button');
      bundle.setAttribute('aria-label', '打包下载本次结果');
      bundle.href = '/api/codex/clean-results/archive?session=' + encodeURIComponent(saved[mod.id].sessionId) + '&run=' + encodeURIComponent(view.runId);
      bundle.title = '包含本次结果、代码和说明，不混入其他运行或原始输入';
      if (t.busy) { bundle.removeAttribute('href'); bundle.setAttribute('aria-disabled', 'true'); bundle.title = '任务完成后可打包下载'; }
      heading.append(select, bundle); list.append(heading);
      if (view.cleaning) {
        const include = node('input'); include.type='checkbox'; include.checked=!!t.cleanBundleInputs; include.disabled=t.busy;
        const label=node('label','复现包包含原始输入 '); label.append(include);
        const reproduce=node('a','下载复现包','quiet-button');
        const update=()=>{ reproduce.href='/api/codex/cleaning/archive?session='+encodeURIComponent(saved[mod.id].sessionId)+'&id='+encodeURIComponent(view.runId)+(t.cleanBundleInputs?'&inputs=1':''); };
        include.onchange=()=>{t.cleanBundleInputs=include.checked;update();}; update();
        const replay=node('button','按原脚本另建版本重跑','quiet-button'); replay.type='button'; replay.disabled=t.busy || !view.cleaning.scriptSha256;
        replay.onclick=async()=>{t.busy=true;t.error='';render();try{const job=await request('/api/codex/cleaning/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:await session(mod.id),id:view.runId,confirm:true})});saved[mod.id].jobId=job.id;persist();Store.setModuleStatus(mod.id,'doing');await watch(mod.id,job.id);}catch(error){t.error=error.message;}finally{t.busy=false;render();}};
        if(t.busy || !view.cleaning.scriptSha256) reproduce.removeAttribute('href');
        heading.append(label,reproduce,replay);
        list.append(node('p','运行状态：'+view.cleaning.status+'；规则 v'+view.cleaning.rules.version+'；固定核验：'+(view.cleaning.verification?.status||'尚未完成')+'；研究者验收未判定。','codex-status'));
      }
      [['main', '主要结果', '本次尚未生成主要结果数据。'], ['reports', '检查报告', '本次尚未生成检查报告。'], ['issues', '待处理问题', '所列问题清单中没有记录；是否通过验收仍以检查报告和人工核查为准。']].forEach(([group, title, empty]) => {
        const section = node('section', undefined, 'clean-result-section'); section.append(node('h4', title));
        if (view.groups[group].length) view.groups[group].forEach(file => section.append(cleanResultLink(mod.id, file)));
        else section.append(node('p', empty, 'clean-result-meta'));
        list.append(section);
      });
      const auxiliary = node('details', undefined, 'clean-result-aux'); auxiliary.append(node('summary', '辅助文件（' + view.groups.auxiliary.length + '）· 代码、说明及其他检查材料'));
      view.groups.auxiliary.forEach(file => auxiliary.append(cleanResultLink(mod.id, file))); list.append(auxiliary);
    } else list.append(node('p', '还没有清洗结果。先讨论并确认规则，再执行清洗。', 'codex-status'));
    const originals = node('details', undefined, 'clean-result-aux'); originals.append(node('summary', '原始文件（' + view.inputs.length + '）'));
    view.inputs.forEach(file => { const batch = saved[mod.id]?.inputBatch; originals.append(cleanResultLink(mod.id, { ...file, label: batch ? batch.names.includes(file.name) ? '当前原始文件' : '历史原始文件' : '原始文件' })); }); list.append(originals);
    if (view.otherFiles.length) { const extra = node('details', undefined, 'clean-result-aux'); extra.append(node('summary', '其他保留文件（' + view.otherFiles.length + '）')); view.otherFiles.forEach(file => extra.append(cleanResultLink(mod.id, file))); list.append(extra); }
  }
  function render() {
    root.LiteratureRuleReview?.closeIfContextChanged();
    root.TaskManager?.refreshControls();
    renderConnection();
    if (literatureFieldsDialog) {
      const current = task(literatureFieldsDialog.mod.id);
      const stamp = JSON.stringify([current.literatureJob?.id, current.literatureJob?.status, current.busy, current.literatureBusy, !!root.LiteratureUI?.isBusy()]);
      if (literatureFieldsDialog.lockStamp !== stamp) renderLiteratureFieldsDialog();
    }
    const state = Store.getState();
    const mod = state.modules.find(m => m.id === state.activeModuleId);
    document.body?.classList?.toggle('literature-reading-view', mod?.type === 'literature-mining');
    panel.hidden = !mod || !document.getElementById('records-view').hidden;
    if (panel.hidden) return;
    const t = task(mod.id);
    const literatureView = mod.type === 'literature-mining';
    const contextId = literatureView ? literatureWorkspaceManager(mod)?.active()?.id || '' : '';
    const scrollKey = literatureView ? [mod.id, contextId, t.literatureJob?.id || saved[mod.id]?.literatureJobId || 'draft'].join(':') : '';
    // 轮询期间内容会缩短并夹紧 scrollTop；记住用户最后一次真实的滚动位置，
    // 重建后按较大值恢复，避免“下滑就弹回顶部”。
    if (literatureView && !panel.literatureScrollBound) {
      panel.literatureScrollBound = true;
      panel.addEventListener('scroll', () => {
        if (panel.literatureScrollKey) panel.literatureScrollTop = panel.scrollTop;
      });
    }
    const sameScrollContext = literatureView && panel.literatureScrollKey === scrollKey;
    const previousScroll = sameScrollContext ? Math.max(panel.scrollTop, panel.literatureScrollTop || 0) : 0;
    if (!sameScrollContext) panel.literatureScrollTop = 0;
    panel.literatureScrollKey = scrollKey;
    if (literatureView) { panel.tabIndex = 0; panel.setAttribute('aria-label', '文献任务滚动区域'); }
    else { panel.removeAttribute('tabindex'); panel.removeAttribute('aria-label'); }
    panel.replaceChildren();
    if (mod.type === 'download-data') {
      panel.append(node('h3', '按方案下载数据'));
      panel.append(node('p', '直接讨论 → 形成并审核方案 → 点击开始下载。FAOSTAT贸易矩阵自动定位官方整包并按年份筛选；方案已有文件地址的数据源也通过同一任务下载。大文件流式保存，每个文件支持至2GiB，无需手动找FAO链接。', 'codex-status'));
      panel.append(downloadVerificationControls(mod, t));
    }
    if (mod.type === 'clean-data') { panel.append(cleanVerificationControls(mod, t)); panel.append(cleanAcceptancePanel(mod, t)); }
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
        mode.onchange = () => { t.execute = false; if (mode.value === 'execute') root.TaskManager?.openPlan(); else render(); };
        row.append(mode);
      }
    }
    panel.append(row);
    if (mod.type === 'literature-mining') {
      literaturePanel(mod, t);
      if (t.error) panel.append(node('p', t.error, 'codex-error'));
      panel.scrollTop = previousScroll;
      panel.literatureScrollTop = previousScroll;
      const restoreStageLog = () => {
        const stageLog = panel.querySelector('.literature-stage-log');
        if (stageLog && t.literatureStageScroll) stageLog.scrollTop = t.literatureStageScroll;
      };
      restoreStageLog();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreStageLog);
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
    toggle.append(node('span', mod.type === 'clean-data' ? '清洗结果' : '文件与结果 · ' + t.files.length));
    const chevron = node('span', undefined, 'codex-chevron'); chevron.setAttribute('aria-hidden', 'true'); toggle.append(chevron);
    files.append(toggle);
    files.ontoggle = () => { if (!files.isConnected) return; t.filesOpen = files.open; toggle.setAttribute('aria-expanded', String(files.open)); };
    const fileRow = node('div', undefined, 'codex-toolbar');
    if (mod.type !== 'result-audit' && mod.type !== 'download-data') {
      const input = node('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
      input.accept = mod.type === 'calculation' ? '.py,.r,.R,.jl,.m,.ipynb,.csv,.tsv,.xlsx,.xls,.json,.txt' : '.csv,.tsv,.xlsx,.xls,.json,.txt';
      input.disabled = t.busy;
      input.setAttribute('aria-label', mod.type === 'calculation' ? '上传计算代码和输入数据' : mod.type === 'plotting' ? '上传绘图数据' : '上传清洗原始文件');
      input.onchange = () => upload(mod.id, Array.from(input.files || []));
      const choose = node('button', '选择文件', 'quiet-button'); choose.type = 'button'; choose.disabled = t.busy; choose.onclick = () => input.click();
      const uploaded = t.files.filter(file => file.group === 'input');
      const selectedCount = mod.type === 'clean-data' ? cleanInputSelection(mod.id).length : uploaded.length;
      const uploadStatus = node('span', uploaded.length ? '已上传 ' + uploaded.length + ' 个' + (mod.type === 'clean-data' ? ' · 本次已选 ' + selectedCount + ' 个' : '文件') : '尚未上传文件', 'codex-upload-status codex-status');
      uploadStatus.title = uploaded.map(file => file.name.replace(/^[a-f0-9]{8}-/, '')).join('\n');
      uploadStatus.setAttribute('role', 'status'); uploadStatus.setAttribute('aria-live', 'polite');
      fileRow.append(choose, input, uploadStatus);
    }
    const refreshButton = node('button', '刷新文件', 'quiet-button'); refreshButton.type = 'button'; refreshButton.disabled = t.busy; refreshButton.onclick = () => refresh(mod.id); fileRow.append(refreshButton);
    if (mod.type === 'download-data') {
      const acceptance = downloadAcceptancePanel(mod, t); if (acceptance) panel.append(acceptance);
      const start = node('button', '按方案开始下载', 'primary-button'); start.type = 'button'; start.disabled = t.busy || !basisForDownload(mod) || !!root.ModuleSpace?.isBusy(); start.onclick = () => openDownload(mod); fileRow.append(start);
      const handoff = node('button', saved[mod.id]?.download?.confirmed ? '查看已交接的清洗模块' : '确认文件并进入清洗', 'quiet-button'); handoff.type = 'button'; handoff.disabled = !downloadAcceptanceCanHandoff(mod, t); handoff.onclick = () => handoffDownload(mod); fileRow.append(handoff);
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
      stop.onclick = async () => { try { await request('/api/codex/cancel?id=' + t.job.id + '&session=' + encodeURIComponent(saved[mod.id]?.sessionId || ''), { method: 'POST' }); } catch (error) { t.error = error.message; render(); } };
      row.append(stop);
    }
    if (mod.type === 'clean-data') { row.classList.add('codex-clean-toolbar'); row.append(...fileRow.childNodes); }
    else panel.append(fileRow);
    if (mod.type === 'download-data') sourceDownloadPanel(mod, t);
    if (mod.type === 'plotting') plotPanel(mod,t);
    if (mod.type === 'clean-data') cleaningPanel(mod,t);
    if (mod.type === 'result-audit') panel.append(node('p', '先讨论并在上方确认核查原则，或直接上传已有标准；再核查结果、讨论定位。每个标准文件上限 20MB。', 'codex-status'));
    if (mod.type === 'clean-data' && saved[mod.id]?.inputBatch) panel.append(node('p', '当前交接输入 ' + saved[mod.id].inputBatch.names.length + ' 个；历史原始文件保留，不自动合并到本次清洗。', 'codex-status'));
    if (mod.type === 'clean-data' && t.cleanRuleSyncNotice) panel.append(node('p',t.cleanRuleSyncNotice,'codex-status'));
    if (mod.type === 'clean-data' && t.cleanRuleSyncError) panel.append(node('p','规则同步尚未完成：'+t.cleanRuleSyncError,'codex-error'));
    const list = node('div', undefined, 'codex-files');
    list.id = 'codex-file-list';
    if (mod.type === 'clean-data') renderCleanResults(mod, t, list);
    else {
    list.append(node('p', mod.type === 'result-audit' ? '与计算模块共享输入及各次输出；点击文件名下载。' : mod.type === 'download-data' ? '下载的原始文件与下载记录；点击文件名保存到本机。' : '上传文件与本次结果；点击文件名下载。每个上传文件上限 20MB。'));
    if (!t.files.length) list.append(node('p', mod.type === 'result-audit' ? '还没有计算文件，请先在计算模块运行。' : mod.type === 'download-data' ? '尚未下载文件，请确认规则后开始下载。' : '还没有文件，请先选择原始数据。'));
    t.files.forEach(file => {
      const displayName = file.name.split('/').pop().replace(/^[0-9a-f]{8}-/, '');
      const batch = mod.type === 'clean-data' && saved[mod.id]?.inputBatch;
      const link = node('a', (file.group === 'input' ? batch ? batch.names.includes(file.name) ? '当前原始 · ' : '历史原始 · ' : '原始 · ' : file.group === 'reference' ? '核查标准 · ' : '结果 · ') + displayName + ' · ' + Math.ceil(file.size / 1024) + 'KB');
      link.title = file.name;
      link.href = '/api/codex/download?session=' + saved[mod.id]?.sessionId + '&group=' + file.group + '&name=' + encodeURIComponent(file.name); list.append(link);
    });
    }
    files.append(list); (mod.type === 'clean-data' ? row : fileRow).append(files);
    if (t.busy && !t.sourceJob) panel.append(node('p', t.job ? 'Codex 正在处理…' : '上传或启动中…', 'codex-status'));
    if (t.job?.events.length) { const log = node('details'); log.open = t.logOpen; log.ontoggle = () => { t.logOpen = log.open; }; log.append(node('summary', '执行进度')); log.append(node('pre', t.job.events.join('\n'))); panel.append(log); }
    if (t.error) panel.append(node('p', t.error, 'codex-error'));
  }
  root.CodexUI = { render, reply, openDownload, prepareConfirmedExecution, cancelPreparedExecution, prepareRuleDiscussion, session, refresh, confirmCleanAcceptance, syncCleanRuleUpdate,
    cleanSessionId: id => saved[id]?.sessionId || null,
    literatureWorkspace: id => { const mod = Store.getState().modules.find(item => item.id === id); return mod?.type === 'literature-mining' ? literatureWorkspaceManager(mod) : null; },
    renderLiteratureWorkspace: id => { const mod = Store.getState().modules.find(item => item.id === id); render(); ModuleSpace.render(); if (mod) void hydrateLiteratureWorkspace(mod); },
    getConnection: mod => ({ backend: task(mod.id).backend, model: task(mod.id).model || (task(mod.id).backend === 'codex' ? account?.model : null) || null }),
    setInputBatch: (id, batch) => { saved[id] = { ...saved[id], inputBatch: batch }; persist(); },
    useCodex: mod => !!mod && task(mod.id).backend === 'codex', getModel: mod => mod ? task(mod.id).model || null : null, busy: id => task(id).busy || task(id).literatureBusy || task(id).sourceAcceptanceLoading || task(id).sourceAcceptanceBusy || task(id).cleanAcceptanceLoading || task(id).cleanAcceptanceBusy || task(id).cleanRunsLoading,
    literatureJobId: id => (saved[id] && saved[id].literatureJobId) || '' };
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
    if (saved[id].sourceJobId) watchSourceDownload(id, saved[id].sourceJobId).catch(() => {});
  });
})(window);
