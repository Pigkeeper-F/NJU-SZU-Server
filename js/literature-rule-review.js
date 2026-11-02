/* Human/AI review of the actual literature configuration. The server owns revisions. */
(function (root) {
  'use strict';
  let active = null;
  const pendingAssistCancels = new Map();
  const frozenGroups = [
    { id: 'scope', title: '研究范围与条件', itemIds: ['topic', 'years', 'region-language', 'study-types'] },
    { id: 'search', title: '来源与检索式', itemIds: ['sources', 'query', 'source-queries'] },
    { id: 'delivery', title: '纳排与交付要求', itemIds: ['eligibility', 'fields', 'templates'] },
    { id: 'execution', title: '执行范围与边界', itemIds: ['search-mode', 'processing', 'timeouts', 'stage'] }
  ];
  const labels = { topic: '研究主题', query: '默认检索式', sources: '检索来源', sourceQueries: '各来源检索式', scholarPlan: '谷歌学术分批计划',
    publicationYearFrom: '发表年份起', publicationYearTo: '发表年份止', geography: '地区', language: '语言', studyTypes: '文献 / 研究类型',
    inclusion: '纳入规则', exclusion: '排除规则', targetFields: '目标字段', fieldDefinitions: '字段定义', templates: '提取模板',
    searchMode: '运行模式', stopMode: '停止方式', perSourceLimit: '每来源数量上限', limit: '每批数量', batch: '分批配置',
    fulltext: '全文获取设置', extraction: '提取设置', limits: '阶段限制', until: '本次做到哪一步', version: '配置结构版本', source: '规则依据版本' };
  const choices = { searchMode: [['formal', '正式检索'], ['test', '测试运行']], stopMode: [['end', '检索到可访问末页'], ['count', '按数量']],
    until: [['discover', '仅检索候选'], ['dedupe', '检索并去重'], ['fulltext', '获取全文'], ['extract', '提取参数'], ['validate', '校验'], ['export', '导出']] };
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const json = value => JSON.stringify(value, null, 2);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function button(label, fn, primary = false) { const el = node('button', label, primary ? 'primary-button' : 'quiet-button'); el.type = 'button'; el.onclick = fn; return el; }
  function close() { if (active?.dialog?.open) active.dialog.close(); }
  function closeIfContextChanged() { if (active && !active.adapter.isCurrent()) close(); }
  function matches(review, config, until, source) {
    return !!review?.ready && review.until === until && JSON.stringify(canonical(review.config)) === JSON.stringify(canonical(config))
      && (review.source === undefined || review.source === source);
  }
  function describe(value, key, adapter) {
    if (key === 'sources' && Array.isArray(value)) return value.map(item => adapter.sourceLabels?.[item] || item).join('、') || '未设置';
    if (key === 'scholarPlan' && value?.topics) return ['每5年分批；按相关性排序。', ...value.topics.map(topic =>
      (topic.label || topic.id) + '：' + topic.query + (topic.refinementQueries?.length ? '\n预定细分：' + topic.refinementQueries.join('；') : '')),
      value.trialMaxPages != null ? '本次预试最多' + value.trialMaxPages + '页，仅候选；不能视为检全，不获取全文或提取数据。' : '遇到访问限制保留断点和覆盖缺口。'].join('\n');
    if (choices[key]) return choices[key].find(item => item[0] === value)?.[1] || String(value ?? '未设置');
    if (value === null || value === undefined || value === '') return '未设置';
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join('\n') || '未设置';
    return typeof value === 'object' ? json(value) : String(value);
  }
  function fromConfirmedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.reviewId !== 'string' || !snapshot.reviewId
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.confirmedAt !== 'string' || !snapshot.confirmedAt
      || !snapshot.config || typeof snapshot.config !== 'object' || Array.isArray(snapshot.config)
      || !choices.until.some(([value]) => value === snapshot.until) || !Array.isArray(snapshot.items) || snapshot.items.length !== 14) {
      throw new Error('没有可用的完整核查快照，无法还原确认记录。');
    }
    for (const group of frozenGroups) for (const id of group.itemIds) {
      const entries = snapshot.items.filter(item => item.id === id);
      if (entries.length !== 1 || entries[0].groupId !== group.id || entries[0].status !== 'confirmed'
        || !entries[0].value || typeof entries[0].value !== 'object' || Array.isArray(entries[0].value)
        || !Array.isArray(entries[0].history)) throw new Error('核查快照缺少完整确认记录，未显示为已确认。');
    }
    const review = copy(snapshot);
    return { ...review, id: snapshot.reviewId, groups: copy(frozenGroups), currentGroupId: frozenGroups[0].id,
      progress: { confirmed: snapshot.items.filter(item => item.status === 'confirmed').length, total: snapshot.items.length }, ready: true };
  }
  async function openFrozenJob(jobId, options = {}) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId || '')) throw new Error('文献任务标识无效，未读取快照。');
    const read = options.request || (async url => {
      const response = await root.fetch(url, { headers: { 'X-Workbench': '1' } });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '核查快照无法读取'); return value;
    });
    return open({ readOnly: true, sourceJobId: jobId, sourceJobTitle: options.title, sourceLabels: options.sourceLabels || {}, onRevise: options.onRevise, canRevise: options.canRevise, reviseLabel: options.reviseLabel,
      isCurrent: options.isCurrent || (() => true), loadSnapshot: () => read('/api/literature/download?id=' + encodeURIComponent(jobId) + '&name=rule-review-confirmed.json') });
  }
  async function open(adapter) {
    if (active) close();
    const dialog = node('dialog', undefined, 'literature-rule-review-dialog');
    dialog.setAttribute('aria-label', adapter.readOnly ? '查看已确认配置' : '逐项核查检索规则');
    const state = { dialog, adapter, review: null, busy: true, error: '', editing: null, questions: {}, overview: false, assistTried: new Set(), assistStart: null, assistFinished: true };
    active = state;
    const valid = () => active === state && dialog.open && adapter.isCurrent();
    const post = (route, body) => adapter.request('/api/literature/rule-review/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function accept(review) { if (!valid()) return false; state.review = review; if (!adapter.readOnly) adapter.onSave(copy(review)); return true; }
    async function mutate(action, extras = {}) {
      if (adapter.readOnly || state.busy || !valid()) return;
      state.busy = true; state.error = ''; draw();
      try { accept(await post('action', { id: state.review.id, sessionId: adapter.sessionId, revision: state.review.revision, action, ...extras })); }
      catch (error) { if (valid()) { state.error = error.message; if (error.status === 409) await reload(); } }
      finally { if (valid()) { state.busy = false; draw(); } }
    }
    async function reload() {
      const review = await adapter.request('/api/literature/rule-review?id=' + encodeURIComponent(state.review.id) + '&sessionId=' + encodeURIComponent(adapter.sessionId));
      accept(review);
    }
    async function assist(mode, itemId, message = '') {
      if (adapter.readOnly || state.busy || !valid()) return;
      const revision = state.review.revision, groupId = state.review.currentGroupId;
      state.busy = true; state.error = ''; draw();
      try {
        state.assistFinished = false;
        state.assistStart = post('assist', { id: state.review.id, sessionId: adapter.sessionId, revision, mode, groupId, itemId, message, model: adapter.model });
        let job = await state.assistStart;
        const jobId = job.id;
        if (!valid()) return;
        while (job.status === 'running' || job.status === 'queued') {
          await new Promise(resolve => setTimeout(resolve, 1200));
          if (!valid()) return;
          job = await adapter.request('/api/codex/job?id=' + encodeURIComponent(jobId));
        }
        if (!valid()) return;
        state.assistFinished = true;
        if (job.status !== 'completed') throw new Error(job.error || 'AI 说明未完成，请重试。');
        accept(await post('assist-result', { id: state.review.id, sessionId: adapter.sessionId, revision, jobId }));
      } catch (error) { if (valid()) { state.error = error.message; if (error.status === 409) await reload(); } }
      finally { if (valid()) { state.assistStart = null; state.assistFinished = true; state.busy = false; draw(); } }
    }
    function groupItems() { return state.review.items.filter(item => item.groupId === state.review.currentGroupId); }
    function maybeAssist() {
      if (adapter.readOnly || !valid() || !state.review || state.busy || state.overview) return;
      const groupId = state.review.currentGroupId;
      if (!state.assistTried.has(groupId) && groupItems().some(item => !item.annotation?.explanation)) {
        state.assistTried.add(groupId); void assist('group');
      }
    }
    async function changeGroup(id) {
      state.editing = null; state.overview = false;
      if (adapter.readOnly) { if (state.review.groups.some(group => group.id === id)) state.review.currentGroupId = id; draw(); return; }
      await mutate('set-group', { groupId: id }); maybeAssist();
    }
    function editor(item) {
      const form = node('form', undefined, 'rule-review-editor'), readers = [];
      Object.keys(item.value).forEach(key => {
        const original = item.value[key], wrap = node('label', labels[key] || key);
        let field, read;
        if (key === 'version') {
          field = node('input'); field.type = 'text'; field.value = original; field.readOnly = true; read = () => original;
        } else if (key === 'scholarPlan' && original?.topics) {
          field = node('div'); const readers = [];
          original.topics.forEach((topic, index) => {
            const label = node('label', topic.label || topic.id), query = node('textarea'); query.rows = 2; query.maxLength = 32768; query.value = topic.query;
            query.setAttribute('aria-label', '修改谷歌学术主题短查询 ' + (index + 1)); label.append(query); field.append(label); readers.push(query);
          });
          field.append(node('small', original.trialMaxPages != null ? '预试最多' + original.trialMaxPages + '页，仅候选；此处修改查询不扩大运行范围。年份在第一组核查。' : '每5年分批、按相关性排序；年份在第一组核查。'));
          read = () => { const value = copy(original); value.topics.forEach((topic, index) => { topic.query = readers[index].value.trim(); }); return value; };
        } else if (key === 'sources' && Array.isArray(original)) {
          field = node('div', undefined, 'rule-review-source-options'); const checks = [];
          [...new Set([...Object.keys(adapter.sourceLabels || {}), ...original])].forEach(source => {
            const label = node('label', adapter.sourceLabels?.[source] || source), check = node('input'); check.type = 'checkbox'; check.checked = original.includes(source);
            check.setAttribute('aria-label', '检索来源 ' + (adapter.sourceLabels?.[source] || source)); label.prepend(check); field.append(label); checks.push([source, check]);
          }); read = () => checks.filter(([, check]) => check.checked).map(([source]) => source);
        } else if (choices[key]) {
          field = node('select');
          choices[key].forEach(([value, title]) => { const option = node('option', title); option.value = value; field.append(option); });
          field.value = original ?? ''; read = () => field.value;
        } else if (typeof original === 'boolean') {
          field = node('input'); field.type = 'checkbox'; field.checked = original; read = () => field.checked;
        } else if (typeof original === 'number' || /^publicationYear|^(limit|perSourceLimit)$/.test(key)) {
          field = node('input'); field.type = 'number'; field.step = '1'; field.value = original ?? '';
          read = () => { if (!field.value.trim()) return null; const value = Number(field.value); if (!Number.isFinite(value)) throw new Error((labels[key] || key) + '须为数字'); return value; };
        } else if (Array.isArray(original) && key !== 'fieldDefinitions' && original.every(value => typeof value === 'string')) {
          field = node('textarea'); field.rows = 4; field.value = original.join('\n');
          wrap.append(node('small', key === 'sources' ? '每行一个来源标识；可用标识：' + Object.keys(adapter.sourceLabels || {}).join('、') : '每行一项'));
          read = () => field.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        } else if (typeof original === 'object' && original !== null) {
          field = node('textarea'); field.rows = 6; field.value = json(original); field.spellcheck = false;
          wrap.append(node('small', '保留 JSON 结构；保存时检查类型。'));
          read = () => { const value = JSON.parse(field.value); if (Array.isArray(value) !== Array.isArray(original) || !value || typeof value !== 'object') throw new Error((labels[key] || key) + '的结构类型不符'); return value; };
        } else {
          field = node('textarea'); field.rows = key === 'query' ? 4 : 2; field.value = original ?? ''; read = () => field.value;
        }
        field.setAttribute('aria-label', '修改' + (labels[key] || key)); field.disabled = state.busy; wrap.append(field); form.append(wrap); readers.push([key, read]);
      });
      const actions = node('div', undefined, 'rule-review-actions');
      const save = button('保存修改，待重新确认', () => {} , true); save.type = 'submit';
      actions.append(save, button('取消修改', () => { state.editing = null; draw(); })); form.append(actions);
      form.onsubmit = async event => {
        event.preventDefault();
        try { const value = Object.fromEntries(readers.map(([key, read]) => [key, read()])); state.editing = null; await mutate('edit', { itemId: item.id, value }); }
        catch (error) { state.error = '修改未保存：' + error.message; draw(); }
      };
      return form;
    }
    function itemCard(item) {
      const card = node('section', undefined, 'rule-review-item' + (item.status === 'confirmed' ? ' is-confirmed' : ''));
      const heading = node('div', undefined, 'rule-review-item-heading');
      heading.append(node('h3', item.title), node('span', item.status === 'confirmed' ? '已确认' : '待确认', 'rule-review-badge')); card.append(heading);
      if (item.id === 'fields' || Object.prototype.hasOwnProperty.call(item.value || {}, 'targetFields')) {
        card.append(node('p', state.review.until === 'discover'
          ? '本次仅检索候选，不调用全文参数提取。这里核对后续要采集的科学变量及定义；检索台账和通用表格结构列不能替代科学指标。'
          : '这里核对科学变量及定义；检索台账和通用表格结构列不直接作为科学指标。', 'codex-status'));
      }
      const values = node('dl', undefined, 'rule-review-values');
      const plan = state.review.config?.scholarPlan;
      Object.entries(item.value || {}).forEach(([key, value]) => {
        const text = plan?.trialMaxPages != null && key === 'searchMode' ? '谷歌学术预试分页模式（最多' + plan.trialMaxPages + '页，仅候选）'
          : plan?.trialMaxPages != null && key === 'stopMode' ? '先到预试页数上限即停止；不会运行整个正式检索' : describe(value, key, adapter);
        values.append(node('dt', labels[key] || key), node('dd', text));
      });
      card.append(values);
      if (item.id === 'search-mode' && plan) card.append(node('p', '谷歌学术计划：' + plan.topics.length + '个主题，每5年分批，按相关性排序；'
        + (plan.trialMaxPages != null ? '本次最多' + plan.trialMaxPages + '页，仅候选。' : '受限批次保存覆盖缺口。')
        + '实际短查询请在“来源与检索式”组核对；修改计划后本项也需要重新确认。', 'codex-status'));
      const annotation = item.annotation;
      if (annotation && Object.values(annotation).some(Boolean)) {
        const notes = node('div', undefined, 'rule-review-ai');
        [['explanation', 'AI 理解'], ['basis', '规则依据 / 差异'], ['impact', '执行影响'], ['recommendation', '建议']].forEach(([key, title]) => { if (annotation[key]) { notes.append(node('strong', title), node('p', typeof annotation[key] === 'string' ? annotation[key] : json(annotation[key]))); } });
        card.append(notes);
      } else card.append(node('p', adapter.readOnly ? '此快照未保存 AI 说明。' : state.busy ? 'AI 正在整理本组说明…' : '尚无 AI 说明，可点击“让 AI 解释”。', 'codex-status'));
      if (!adapter.readOnly && state.editing === item.id) card.append(editor(item));
      else if (!adapter.readOnly) {
        const actions = node('div', undefined, 'rule-review-actions');
        const confirm = button(item.status === 'confirmed' ? '已确认' : '确认这一项', () => mutate('confirm', { itemId: item.id }), true);
        confirm.disabled = item.status === 'confirmed';
        actions.append(confirm, button('修改', () => { state.editing = item.id; draw(); })); card.append(actions);
      }
      if (!adapter.readOnly) {
      const question = node('div', undefined, 'rule-review-question');
      const input = node('input'); input.type = 'text'; input.placeholder = '哪里不理解？也可以直接点击解释'; input.value = state.questions[item.id] || '';
      input.setAttribute('aria-label', '关于' + item.title + '的问题'); input.oninput = () => { state.questions[item.id] = input.value; };
      question.append(input, button('让 AI 解释', () => assist('explain', item.id, state.questions[item.id] || ''))); card.append(question);
      }
      if (item.discussion?.length) {
        const history = node('details'); history.append(node('summary', '查看问答记录 · ' + item.discussion.length));
        item.discussion.forEach(entry => {
          if (typeof entry === 'string') history.append(node('p', entry));
          else { if (entry.question) history.append(node('p', '你：' + entry.question)); if (entry.answer) history.append(node('p', 'AI：' + entry.answer)); }
        }); card.append(history);
      }
      if (item.history?.length) {
        const history = node('details'); history.append(node('summary', '修改与确认历史 · ' + item.history.length));
        item.history.forEach(entry => history.append(node('pre', json(entry)))); card.append(history);
      }
      return card;
    }
    function draw() {
      if (!dialog.open) return;
      dialog.replaceChildren();
      const top = node('div', undefined, 'dialog-top'); top.append(node('span', adapter.readOnly ? '启动时的核查快照 · 只读' : '人机协作核查', 'eyebrow'), button('关闭', close)); dialog.append(top);
      const sourceTitle = adapter.sourceJobTitle || state.review?.config?.topic || '文献任务';
      dialog.append(node('h2', adapter.readOnly ? '查看已确认配置' : '逐项核查检索规则'));
      if (adapter.readOnly && state.review) dialog.append(node('h3', sourceTitle + ' · ' + adapter.sourceJobId.slice(0, 8)));
      dialog.append(node('p', adapter.readOnly
        ? '来源任务：' + sourceTitle + '（' + adapter.sourceJobId + '）。这里显示启动时冻结的配置、说明与确认历史，不修改草稿或继续执行任务。'
        : 'AI 解释实际配置，你确认或修改。每次操作保存到当前文献任务；全部确认后再应用。'));
      if (adapter.formatNotice) dialog.append(node('p', adapter.formatNotice, 'codex-status'));
      if (!adapter.readOnly && adapter.revisionParentId) dialog.append(node('p', '正在修改任务 ' + adapter.revisionParentId.slice(0, 8)
        + ' 的配置。确认后将按新配置开始新检索，原任务及结果保持不变，不复用旧断点。', 'codex-status'));
      if (!state.review) {
        if (state.error) {
          dialog.append(node('h3', adapter.readOnly ? '无可用核查快照' : '未能打开逐项核查'), node('p', adapter.readOnly
            ? '未能读取本次任务的完整已确认快照。不会用当前草稿替代，也不会生成确认记录；原任务保持不变，可重新尝试。'
            : '原规则和检索设置仍保留，未确认或执行任何任务。请重新尝试，或返回检索设置查看并修改。'));
          const error = node('p', state.error, 'codex-error'); error.setAttribute('role', 'alert'); dialog.append(error);
          const actions = node('div', undefined, 'rule-review-actions');
          actions.append(button('重新尝试', () => initialize(), true));
          if (!adapter.readOnly) actions.append(button('返回检索设置', () => { const message = state.error; close(); adapter.onConfigError?.(message); }));
          dialog.append(actions);
        } else dialog.append(node('p', '正在载入核查记录…', 'codex-status'));
        return;
      }
      const review = state.review, group = review.groups.find(item => item.id === review.currentGroupId) || review.groups[0];
      const progress = node('div', undefined, 'rule-review-progress'); progress.setAttribute('aria-live', 'polite');
      progress.append(node('strong', '已确认 ' + review.progress.confirmed + ' / ' + review.progress.total), node('span', adapter.readOnly
        ? '启动时冻结 · 核查版本 ' + review.revision + ' · ' + review.confirmedAt : '服务端已保存 · 版本 ' + review.revision)); dialog.append(progress);
      const tabs = node('nav', undefined, 'rule-review-tabs'); tabs.setAttribute('aria-label', '核查分组');
      review.groups.forEach((entry, index) => {
        const done = review.items.filter(item => item.groupId === entry.id && item.status === 'confirmed').length;
        const tab = button((index + 1) + '. ' + entry.title + ' ' + done + '/' + entry.itemIds.length, () => changeGroup(entry.id));
        if (!state.overview && group.id === entry.id) tab.setAttribute('aria-current', 'step'); tabs.append(tab);
      });
      tabs.append(button('全部总览', () => { state.editing = null; state.overview = true; draw(); })); dialog.append(tabs);
      if (state.overview) {
        dialog.append(node('h3', '全部核查项'));
        review.groups.forEach(entry => {
          const section = node('section', undefined, 'rule-review-overview'); section.append(node('h3', entry.title));
          review.items.filter(item => item.groupId === entry.id).forEach(item => { const row = button((item.status === 'confirmed' ? '✓ 已确认　' : '○ 待确认　') + item.title, () => changeGroup(item.groupId)); section.append(row); }); dialog.append(section);
        });
      } else {
        const heading = node('div', undefined, 'rule-review-group-heading'); heading.append(node('h3', group.title));
        if (!adapter.readOnly) heading.append(button('AI 说明本组', () => assist('group'))); dialog.append(heading);
        groupItems().forEach(item => dialog.append(itemCard(item)));
        const index = review.groups.findIndex(entry => entry.id === group.id), nav = node('div', undefined, 'rule-review-group-nav');
        const previous = button('上一组', () => changeGroup(review.groups[index - 1].id)); previous.disabled = index <= 0;
        const next = button('下一组', () => changeGroup(review.groups[index + 1].id)); next.disabled = index >= review.groups.length - 1;
        nav.append(previous); if (!adapter.readOnly) nav.append(button('确认当前组', () => mutate('group-confirm', { groupId: group.id }), true)); nav.append(next); dialog.append(nav);
      }
      const footer = node('div', undefined, 'rule-review-footer');
      if (adapter.readOnly) {
        if (typeof adapter.onRevise === 'function') {
          const revise = button(adapter.reviseLabel || '修改配置并继续', () => { if (adapter.canRevise === false) return; close(); return adapter.onRevise(); }, true); revise.disabled = adapter.canRevise === false;
          footer.append(node('p', '修改将建立修订草稿，核对后按新配置开始新任务。原任务和结果保留。'), revise, button('关闭', close));
        } else footer.append(node('p', '如需修改，请回到原文献任务使用“修改配置并继续”；也可点击“＋ 新建文献任务”，选择“复用当前规则和表头（需重新核对）”。此只读页面不绑定当前工作区。'), button('关闭', close));
      } else {
      const apply = button('使用已确认配置', () => {
        if (state.busy || !review.ready || !valid()) return;
        try { adapter.onApply(copy(review)); close(); }
        catch (error) { state.error = '配置尚未应用，原任务和草稿保留：' + error.message; draw(); }
      }, true); apply.disabled = !review.ready;
      footer.append(node('p', review.ready ? '全部已确认。应用后回到原入口点击“' + (adapter.revisionParentId ? '按修改后的配置开始' : '按已确认配置检索') + '”。' : '完成全部核查项后才能应用配置。'), apply);
      }
      dialog.append(footer);
      if (state.busy) dialog.append(node('p', '正在保存或生成 AI 说明，请稍候…', 'codex-status'));
      if (state.error) { const error = node('p', state.error, 'codex-error'); error.setAttribute('role', 'alert'); dialog.append(error); }
      if (state.busy) dialog.querySelectorAll('button, input, textarea, select').forEach(field => { if (field.textContent !== '关闭') field.disabled = true; });
    }
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      // Interrupt only this dialog's own explanatory turn. Wait for its start
      // response as well, so closing during POST cannot leave a hidden turn.
      if (state.assistStart && !state.assistFinished) {
        const stopping = state.assistStart.then(job => ['running', 'queued'].includes(job.status)
          ? adapter.request('/api/codex/cancel?id=' + encodeURIComponent(job.id), { method: 'POST' }) : null).catch(() => null);
        pendingAssistCancels.set(adapter.sessionId, stopping);
        void stopping.finally(() => { if (pendingAssistCancels.get(adapter.sessionId) === stopping) pendingAssistCancels.delete(adapter.sessionId); });
      }
      if (active === state) active = null; dialog.remove(); adapter.onClose?.();
    });
    dialog.showModal(); draw();
    async function initialize() {
      if (!valid()) return;
      state.busy = true; state.error = ''; draw();
      try {
      if (adapter.readOnly) {
        const snapshot = await adapter.loadSnapshot();
        if (valid()) accept(fromConfirmedSnapshot(snapshot));
        return;
      }
      if (pendingAssistCancels.has(adapter.sessionId)) await pendingAssistCancels.get(adapter.sessionId);
      if (!valid()) return;
      let review;
      if (adapter.reviewId) {
        try { review = await adapter.request('/api/literature/rule-review?id=' + encodeURIComponent(adapter.reviewId) + '&sessionId=' + encodeURIComponent(adapter.sessionId)); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (!valid()) return;
      if (review) review = await post('action', { id: review.id, sessionId: adapter.sessionId, revision: review.revision, action: 'sync',
        config: adapter.config, until: adapter.until, source: adapter.source, context: adapter.context });
      else review = await post('create', { sessionId: adapter.sessionId, workspaceId: adapter.workspaceId, config: adapter.config,
        until: adapter.until, source: adapter.source, context: adapter.context });
      accept(review);
      } catch (error) { if (valid()) state.error = error.message; }
      finally { if (valid()) { state.busy = false; draw(); maybeAssist(); } }
    }
    await initialize();
  }
  root.LiteratureRuleReview = { open, openFrozenJob, close, closeIfContextChanged, matches };
  if (root.location?.search) {
    const jobId = new URLSearchParams(root.location.search).get('literatureReview');
    if (jobId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId)) void openFrozenJob(jobId);
  }
})(window);
