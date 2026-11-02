(function(root) {
  'use strict';
  // Preparing a confirmed source task never starts retrieval or extraction.
  let active = null;
  const LABELS = { include: '普通候选', pending: '待定', exclude: '排除' };
  const VIEW_LABELS = { ...LABELS, unscreened: '未筛选' };
  const decisionKey = record => LABELS[record.decision] ? record.decision : 'unscreened';
  const DATABASES = { cnki: '中国知网', wanfang: '万方', wos: 'Web of Science', scopus: 'Scopus', scholar: 'Google Scholar', google_scholar: 'Google Scholar' };
  const LINES = { production: '生产', emission: '排放', emissions: '排放' };
  const str = value => typeof value === 'string' ? value.trim() : '';
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (cls) el.className = cls;
    return el;
  };
  function button(label, action, primary = false) {
    const el = node('button', label, primary ? 'primary-button' : 'quiet-button');
    el.type = 'button'; el.onclick = action; return el;
  }
  function field(label, input) {
    const wrapper = node('label', undefined, 'lcp-field');
    input.setAttribute('aria-label', label); wrapper.append(node('span', label), input); return wrapper;
  }
  function option(value, label) { const el = node('option', label); el.value = value; return el; }
  function readable(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
  function queryText(entry) {
    const queries = [];
    if (str(entry.query)) queries.push(str(entry.query));
    for (const item of Array.isArray(entry.queries) ? entry.queries : []) {
      const text = typeof item === 'string' ? str(item) : str(item?.query || item?.text);
      if (text && !queries.includes(text)) queries.push(text);
    }
    return queries.join('\n\n');
  }
  function relativePdf(value) {
    const path = str(value).replace(/\\/g, '/');
    return path && !path.startsWith('/') && !path.includes(':') && path.split('/').every(p => p && p !== '.' && p !== '..') && /\.pdf$/i.test(path) ? path : '';
  }
  function styles() {
    if (document.getElementById('literature-confirmed-plan-styles')) return;
    const style = node('style'); style.id = 'literature-confirmed-plan-styles';
    style.textContent = `
      .lcp-dialog{box-sizing:border-box;width:min(1080px,calc(100vw - 32px));max-width:none;max-height:92vh;margin:auto;padding:24px 28px;color:var(--text,#243d36);font-size:15px;line-height:1.65;overflow-y:auto}
      .lcp-dialog *{box-sizing:border-box}.lcp-dialog h2{font-size:23px;margin:0}.lcp-dialog h3{font-size:17px;margin:0 0 8px}.lcp-dialog p{font-size:14px;color:#53667a;margin:8px 0 14px}
      .lcp-header,.lcp-row,.lcp-tabs{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.lcp-header{justify-content:space-between}.lcp-tabs{margin:16px 0;border-bottom:1px solid #dfe6ee;padding-bottom:12px}
      .lcp-tabs button[aria-pressed=true]{background:#e9f1f7;border-color:#8ca7bf;color:#203e5a}.lcp-dialog button{font:inherit}.lcp-dialog button:disabled{opacity:.5;cursor:not-allowed}
      .lcp-field{display:grid;gap:6px;flex:1;min-width:160px;margin:10px 0}.lcp-dialog select,.lcp-dialog textarea,.lcp-dialog input{font:inherit;width:100%;padding:8px 10px;border:1px solid #cbd6e2;border-radius:7px;background:#fff;color:#243d36}.lcp-dialog textarea{resize:vertical;min-height:80px}
      .lcp-card{border:1px solid #dce4ed;border-radius:10px;padding:16px;margin:14px 0;background:#fff}.lcp-card pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,monospace;background:#f5f7fa;padding:14px;max-height:300px;overflow:auto;margin:12px 0}
      .lcp-muted{font-size:13px;color:#65768b}.lcp-notice{padding:10px 12px;border-radius:7px;background:#edf5f8;white-space:pre-wrap}.lcp-notice[data-error=true]{background:#fff0ee;color:#9c342a}.lcp-notice:empty{display:none}
      .lcp-badge{display:inline-block;border-radius:5px;background:#edf3f9;padding:2px 8px;font-size:13px}.lcp-badge[data-decision=pending]{background:#fff3d6;color:#795b19}.lcp-badge[data-decision=exclude]{background:#f3eeee;color:#72534f}
      .lcp-record-title{white-space:pre-wrap;overflow-wrap:anywhere}.lcp-check{display:flex;gap:8px;align-items:center;margin:14px 0}.lcp-check input{width:auto}.lcp-dialog a{color:#245f99}.lcp-record-reason{white-space:pre-wrap;overflow-wrap:anywhere}.lcp-review{border-top:1px solid #dce4ed;padding-top:12px;margin-top:14px}
      @media(max-width:640px){.lcp-dialog{padding:18px 14px;width:calc(100vw - 16px);max-height:96vh}.lcp-row>.lcp-field{flex-basis:100%}}
    `;
    (document.head || document.body).append(style);
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'X-Workbench': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('服务未返回有效数据，请稍后重试。'); }
    if (!response.ok) { const error = new Error(data.error || '请求失败，请重试。'); error.status = response.status; throw error; }
    return data;
  }
  function close() {
    if (!active) return true;
    if (active.busy) { active.notice('正在保存，请完成后再关闭。'); return false; }
    const state = active; active = null; state.dialog.close(); state.dialog.remove(); return true;
  }
  async function open(options = {}) {
    if (!close()) return active.dialog;
    styles();
    const dialog = node('dialog', undefined, 'lcp-dialog'); dialog.setAttribute('aria-label', '已确认方案与全文筛选');
    const state = { dialog, busy: false, entries: [], records: [], page: 0, filter: 'pending', tab: options.job ? 'screening' : 'plan',
      jobId: str(typeof options.job === 'string' ? options.job : options.job?.id || options.job?.jobId), planSequence: 0, screenSequence: 0 };
    active = state;
    const valid = () => active === state && dialog.open;
    const notice = node('div', undefined, 'lcp-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    state.notice = (text, error = false) => {
      if (!valid()) return; notice.textContent = text; notice.setAttribute('data-error', String(error)); notice.setAttribute('role', error ? 'alert' : 'status');
    };
    const tabs = node('div', undefined, 'lcp-tabs'), plan = node('section'), screening = node('section');
    const planTab = button('已确认检索方案', () => switchTab('plan'));
    const screenTab = button('篇关摘与全文筛选', () => switchTab('screening'));
    const closeButton = button('关闭', close);
    const header = node('div', undefined, 'lcp-header'); header.append(node('h2', '检索方案与文献筛选'), closeButton);
    tabs.append(planTab, screenTab); dialog.append(header, tabs, notice, plan, screening);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (active === state) active = null; dialog.remove(); });
    document.body.append(dialog); dialog.showModal();
    function switchTab(tab) {
      if (state.busy) return;
      state.tab = tab; plan.hidden = tab !== 'plan'; screening.hidden = tab !== 'screening';
      planTab.setAttribute('aria-pressed', String(tab === 'plan')); screenTab.setAttribute('aria-pressed', String(tab === 'screening'));
      state.notice('');
    }
    function lock(value) {
      state.busy = value; closeButton.disabled = value; planTab.disabled = value; screenTab.disabled = value;
      dialog.setAttribute('aria-busy', String(value));
    }
    function callback(name, ...args) {
      try { options[name]?.(...args); }
      catch (_) { state.notice('已保存，但主界面刷新失败。请关闭弹窗后刷新任务列表。', true); }
    }
    async function loadPlan() {
      const sequence = ++state.planSequence; plan.replaceChildren(node('p', '正在读取已确认方案…'));
      try {
        const data = await request('/api/literature/confirmed-plan');
        if (!valid() || sequence !== state.planSequence) return;
        if (!Array.isArray(data.entries)) throw new Error('已确认方案的数据格式不完整。');
        state.entries = [...data.entries, ...(Array.isArray(data.followups) ? data.followups : [])].filter(e => e && str(e.id) && str(e.database)); renderPlan();
      } catch (error) {
        if (!valid() || sequence !== state.planSequence) return;
        plan.replaceChildren(node('p', error.message), button('重新读取方案', loadPlan));
      }
    }
    function renderPlan() {
      plan.replaceChildren(node('p', '选择数据库和研究线，查看已确认检索式与方法。准备任务只保存配置，不开始检索。'));
      if (!state.entries.length) { plan.append(node('p', '当前没有可准备的已确认方案。')); return; }
      const database = node('select'), preset = node('select'), details = node('div'), row = node('div', undefined, 'lcp-row');
      for (const name of [...new Set(state.entries.map(e => e.database))]) database.append(option(name, DATABASES[name] || name));
      database.value = state.entries[0].database;
      row.append(field('数据库', database), field('生产 / 排放方案', preset)); plan.append(row, details);
      function selectDatabase() {
        preset.replaceChildren();
        const matches = state.entries.filter(e => e.database === database.value);
        for (const entry of matches) preset.append(option(entry.id, entry.label || LINES[entry.line] || entry.line || entry.id));
        preset.value = matches[0]?.id || ''; selectPreset();
      }
      function selectPreset() {
        if (state.busy) return;
        const entry = state.entries.find(e => e.id === preset.value);
        details.replaceChildren(); if (!entry) return;
        const card = node('div', undefined, 'lcp-card');
        card.append(node('h3', entry.label || `${DATABASES[entry.database] || entry.database} · ${LINES[entry.line] || entry.line || ''}`));
        if (entry.reportedCount !== undefined && entry.reportedCount !== null) card.append(node('p', `网页核对时报告 ${entry.reportedCount} 条；这是历史命中数，不代表已获取题录或全文。`, 'lcp-muted'));
        const method = entry.method || entry.methods || entry.searchMethod || entry.instructions;
        if (method) card.append(node('p', readable(method)));
        if (entry.notes) card.append(node('p', readable(entry.notes), 'lcp-muted'));
        if (entry.role === 'supplement') card.append(node('p', '补检任务：' + (entry.followupReason || '沿既定查漏原则展开的技术检索式。') + ' 主检索结束后单独准备，不自动启动。该技术式仍需核对源端解析。', 'lcp-notice'));
        const query = queryText(entry);
        card.append(node('pre', query || '未提供可显示的检索式，请核对方案记录。'));
        if (query) card.append(button('复制检索式', async () => {
          try { await root.navigator.clipboard.writeText(query); state.notice('检索式已复制。'); }
          catch (_) { state.notice('无法自动复制，请选中上方检索式复制。', true); }
        }));
        const prepare = button('准备此库任务', async () => {
          if (state.busy) return;
          lock(true); database.disabled = true; preset.disabled = true; prepare.disabled = true;
          state.notice('正在准备任务…');
          try {
            const data = await request('/api/literature/confirmed-plan/prepare', { method: 'POST', body: JSON.stringify({ presetId: entry.id }) });
            if (!valid()) return;
            const id = str(data.job?.id || data.job?.jobId);
            if (!id) throw new Error('服务没有返回已准备的任务标识，请刷新任务列表核对，勿重复提交。');
            state.jobId = id;
            state.notice('任务已准备，尚未启动。请回到任务区，按正常按钮依次检索或导入题录 → 去重 → 筛选并下载。');
            callback('onPrepared', data.job, entry);
            await loadScreening();
          } catch (error) { state.notice(error.message, true); }
          finally { if (valid()) { lock(false); database.disabled = false; preset.disabled = false; prepare.disabled = false; } }
        }, true);
        prepare.disabled = !query;
        details.append(card, prepare, node('p', '准备完成后，按正常任务按钮分阶段执行：检索 / 导入 → 去重 → 篇关摘筛选并下载。待定全文单独保存，默认不提取。', 'lcp-muted'));
      }
      database.onchange = selectDatabase; preset.onchange = selectPreset; selectDatabase();
    }
    async function loadScreening() {
      const sequence = ++state.screenSequence, jobId = state.jobId;
      if (!jobId) { screening.replaceChildren(node('p', '请先准备任务，或从已有任务打开筛选区。')); return; }
      screening.replaceChildren(node('p', '正在读取筛选记录…'));
      try {
        const data = await request('/api/literature/screening?id=' + encodeURIComponent(jobId));
        if (!valid() || sequence !== state.screenSequence || jobId !== state.jobId) return;
        if (!Array.isArray(data.records)) throw new Error('筛选记录格式不完整，请刷新后核对。');
        state.records = data.records.filter(r => r && str(r.paperId)); state.page = 0; renderScreening();
      } catch (error) {
        if (!valid() || sequence !== state.screenSequence) return;
        screening.replaceChildren(node('p', error.message), button('重新读取筛选记录', loadScreening));
      }
    }
    function renderScreening() {
      screening.replaceChildren(node('p', '普通候选仍需核验正文资格；待定单独保存，由你选择，默认不提取。排除记录保留理由，不删除已取得的 PDF。'));
      screening.append(node('div', '当前任务：' + state.jobId, 'lcp-muted'));
      const controls = node('div', undefined, 'lcp-tabs'), list = node('div'), paging = node('div', undefined, 'lcp-row');
      const filterButtons = [];
      for (const [key, label] of [...Object.entries(VIEW_LABELS), ['all', '全部']]) {
        const count = key === 'all' ? state.records.length : state.records.filter(r => decisionKey(r) === key).length;
        const tab = button(`${label} (${count})`, () => { if (!state.busy) { state.filter = key; state.page = 0; paint(); } });
        filterButtons.push([key, tab]); controls.append(tab);
      }
      const refresh = button('刷新记录', () => { if (!state.busy) return loadScreening(); }); controls.append(refresh);
      const search = node('input'); search.type = 'search'; search.placeholder = '按题名或文献编号查找';
      const searchField = field('筛选区查找', search); search.oninput = () => { if (!state.busy) { state.page = 0; paint(); } };
      screening.append(controls, searchField, list, paging);
      function paint() {
        for (const [key, el] of filterButtons) el.setAttribute('aria-pressed', String(state.filter === key));
        const term = search.value.toLocaleLowerCase().trim();
        const records = state.records.filter(r => (state.filter === 'all' || decisionKey(r) === state.filter)
          && (!term || `${r.title || ''} ${r.paperId}`.toLocaleLowerCase().includes(term)));
        const pages = Math.max(1, Math.ceil(records.length / 20)); state.page = Math.min(state.page, pages - 1);
        list.replaceChildren(); paging.replaceChildren();
        if (!records.length) { list.append(node('p', '当前分区没有匹配记录。')); return; }
        for (const record of records.slice(state.page * 20, (state.page + 1) * 20)) list.append(renderRecord(record));
        const previous = button('上一页', () => { if (!state.busy && state.page > 0) { state.page--; paint(); } });
        const next = button('下一页', () => { if (!state.busy && state.page < pages - 1) { state.page++; paint(); } });
        previous.disabled = state.page === 0; next.disabled = state.page === pages - 1;
        paging.append(previous, node('span', `第 ${state.page + 1} / ${pages} 页，共 ${records.length} 条`), next);
      }
      paint();
    }
    function renderRecord(record) {
      const card = node('article', undefined, 'lcp-card'); card.setAttribute('data-paper-id', record.paperId);
      const badge = node('span', VIEW_LABELS[decisionKey(record)], 'lcp-badge'); badge.setAttribute('data-decision', decisionKey(record));
      card.append(badge, node('h3', record.title || record.paperId, 'lcp-record-title'), node('div', record.paperId, 'lcp-muted'),
        node('p', record.reason || '尚无明确判断理由，需进一步核验。', 'lcp-record-reason'));
      if (record.exclusionRule) card.append(node('p', '对应排除规则：' + record.exclusionRule, 'lcp-muted'));
      if (record.abstract) {
        const abstract = node('details'); abstract.append(node('summary', '查看摘要'), node('p', record.abstract, 'lcp-record-reason')); card.append(abstract);
      }
      const path = relativePdf(record.pdfPath);
      if (!path) { card.append(node('p', '全文尚未取得，暂不能作人工全文选择。请先在任务区处理材料获取。', 'lcp-muted')); return card; }
      const link = node('a', '下载全文查看'); link.href = '/api/literature/download?id=' + encodeURIComponent(state.jobId) + '&name=' + encodeURIComponent(path);
      link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      if (!str(record.inputHash) || !str(record.policyHash)) { card.append(node('p', '缺少可核验的题录或规则版本，请刷新记录后再选择。', 'lcp-muted')); return card; }
      const area = node('div'), edit = button('核对全文后选择', () => { if (!state.busy) { edit.hidden = true; area.replaceChildren(reviewForm(record, path)); } });
      card.append(node('div', undefined, 'lcp-row'), edit, area); return card;
    }
    function reviewForm(record, path) {
      const form = node('form', undefined, 'lcp-review'), decision = node('select'), reason = node('textarea'), exclusion = node('input'), pages = node('input'), reviewed = node('input');
      for (const key of ['pending', 'include', 'exclude']) decision.append(option(key, { include: '转普通候选', exclude: '不纳入', pending: '继续待定' }[key]));
      // Opening a form is not a new eligibility decision.
      decision.value = LABELS[record.decision] ? record.decision : 'pending';
      reason.required = true; reason.maxLength = 6000; reason.value = record.reviewer?.type === 'human' ? record.reason || '' : '';
      exclusion.maxLength = 500; pages.required = true; pages.maxLength = 200; pages.placeholder = '例如：第 3 页，表 2；第 5 页试验分组';
      reviewed.type = 'checkbox'; reviewed.required = true;
      const ruleField = field('对应排除规则（不纳入时必填）', exclusion);
      const check = node('label', undefined, 'lcp-check'); check.append(reviewed, node('span', '我已打开并核对这份全文及所填页码'));
      reviewed.setAttribute('aria-label', '已核对全文');
      const local = node('div', undefined, 'lcp-notice'); local.setAttribute('role', 'alert');
      const save = button('保存人工选择', () => {} , true); save.type = 'submit';
      const cancel = button('取消此次编辑', () => { if (!state.busy) renderScreening(); });
      const row = node('div', undefined, 'lcp-row'); row.append(save, cancel);
      form.append(node('h3', '人工全文选择'), node('p', '记录本次判断及原文位置。保存选择不会自动启动下载或提取。', 'lcp-muted'),
        field('全文选择', decision), field('判断理由', reason), ruleField, field('原文页码 / 表图位置', pages), check, local, row);
      const update = () => { ruleField.hidden = decision.value !== 'exclude'; exclusion.required = decision.value === 'exclude'; };
      decision.onchange = update; update(); let conflict = false;
      form.onsubmit = async event => {
        event.preventDefault(); if (state.busy || conflict) return;
        if (!LABELS[decision.value] || !str(reason.value) || !str(pages.value) || !reviewed.checked || (decision.value === 'exclude' && !str(exclusion.value))) {
          local.textContent = '请填写判断理由、原文位置，并确认已核对全文；不纳入时还需写明对应排除规则。'; return;
        }
        const chosen = decision.value, payload = { id: state.jobId, paperId: record.paperId, decision: chosen, reason: reason.value.trim(),
          exclusionRule: chosen === 'exclude' ? exclusion.value.trim() : '', expectedInputHash: record.inputHash, expectedPolicyHash: record.policyHash,
          fulltextReviewed: true, sourceReference: { path, pages: pages.value.trim() } };
        lock(true); for (const el of [save, cancel, decision, reason, exclusion, pages, reviewed]) el.disabled = true;
        local.textContent = '正在保存人工选择…';
        try {
          const result = await request('/api/literature/screening/manual', { method: 'POST', body: JSON.stringify(payload) });
          if (!valid()) return;
          state.notice('人工选择已保存；待定仍不自动提取。');
          callback('onChanged', { jobId: state.jobId, paperId: record.paperId, decision: chosen, result });
          await loadScreening();
        } catch (error) {
          if (!valid()) return;
          conflict = error.status === 409;
          local.textContent = conflict ? '题录或规则版本已变化，本次选择没有保存。请保留你的理由，点击“刷新记录”后按最新材料重新核验。' : error.message;
          local.setAttribute('data-error', 'true');
        } finally {
          if (valid()) { lock(false); for (const el of [cancel, decision, reason, exclusion, pages, reviewed]) el.disabled = false; save.disabled = conflict; }
        }
      };
      return form;
    }
    switchTab(state.tab);
    await Promise.allSettled([loadPlan(), loadScreening()]);
    return dialog;
  }
  root.LiteratureConfirmedPlan = { open, close };
})(window);
