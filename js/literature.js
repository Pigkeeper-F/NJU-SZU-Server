/* Small, resumable literature workflow. All network operations use the local server. */
(function (root) {
  'use strict';
  const key = 'research_literature_runs_v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_) {}
  const states = {};
  const stageNames = { plan: '解析方案', search: '检索文献', screen: '筛选文献', acquire: '获取材料', extract: '提取数据', review: '人工核查' };
  const statusNames = { running: '执行中', waiting: '需要与你讨论', completed: '产物已生成 · 待核查', cancelled: '已停止', failed: '执行失败' };
  const panel = document.createElement('section'); panel.className = 'literature-panel'; panel.setAttribute('aria-label', '文献数据获取执行');
  document.getElementById('module-space').before(panel);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  function persist() { try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {} }
  function state(id) { return states[id] || (states[id] = { run: null, loading: false, watching: false, error: '', answer: '', choices: {}, skip: {}, initialized: false }); }
  function active() { const s = Store.getState(); return s.modules.find(m => m.id === s.activeModuleId); }
  function supported(mod) { return mod && ['download-data', 'literature-mining'].includes(mod.type); }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '文献流程服务不可用'); return data;
  }
  function modelOptions(mod) {
    let settings = null;
    try { settings = JSON.parse(localStorage.getItem('fa_llm_settings_v1')) || null; } catch (_) {}
    return { ...root.CodexUI.getConnection(mod), credential: root.ApiKeys?.getActiveCredential() || null, settings };
  }
  function notify(id) {
    const t = state(id), run = t.run;
    if (!run || run.status === 'running') return;
    const notice = run.status + '|' + run.updatedAt;
    if (saved[id]?.notice === notice) return;
    saved[id].notice = notice; persist();
    if (run.status === 'waiting') Store.appendMessage(id, '文献获取暂停在“' + stageNames[run.stage] + '”，需要与你讨论：\n' + run.questions.join('\n') + '\n可先继续对话讨论；确定后在上方答复并继续，也可上传并关联缺少的材料。', 'assistant');
    if (run.status === 'completed') {
      Store.appendMessage(id, '本批文献获取已生成成果：' + run.candidateCount + ' 篇候选、' + run.selected.length + ' 篇入选、' + run.rowCount + ' 行提取记录。请查看数据表、原文出处和核查报告；未找到的值留空，所有数据仍待人工核查。', 'assistant');
      if (run.rowCount) Store.markRun(id, { dir: '.workbench/' + run.sessionId + '/output/' + run.id, artifacts: run.artifacts.map(f => ({ name: f.name, size: f.size })) });
    }
    void root.CodexUI.refresh(id);
  }
  async function watch(id) {
    const t = state(id); if (t.watching) return;
    t.watching = true;
    try {
      while (saved[id]?.id) {
        t.run = await request('/api/codex/literature/status?session=' + saved[id].sessionId + '&id=' + saved[id].id);
        t.error = ''; render();
        if (t.run.status !== 'running') { notify(id); break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) { t.error = '状态读取失败，已有成果保留。点击刷新状态可重连：' + error.message; }
    finally { t.watching = false; render(); }
  }
  async function start(mod) {
    const t = state(mod.id);
    if (mod.doc?.status !== 'approved') { t.error = '请先审核通过本模块的文献获取方案。'; render(); return; }
    if (root.ModuleSpace.isBusy() || t.loading || t.run?.status === 'running') return;
    t.loading = true; t.error = ''; render();
    try {
      const sid = await root.CodexUI.session(mod.id);
      t.run = await request('/api/codex/literature/start', { sessionId: sid, plan: mod.doc, confirm: true, ...modelOptions(mod) });
      saved[mod.id] = { id: t.run.id, sessionId: sid }; persist();
      t.answer = ''; t.choices = {}; t.skip = {};
      Store.rejectRun(mod.id, 'data', '开始新一批文献获取，产物须重新核查'); Store.setModuleStatus(mod.id, 'doing');
      void watch(mod.id);
    } catch (error) { t.error = error.message; }
    finally { t.loading = false; render(); }
  }
  async function resume(mod) {
    const t = state(mod.id);
    if (!t.run?.scholarVerification && !t.answer.trim() && !Object.values(t.choices).some(Boolean) && !Object.values(t.skip).some(Boolean)) { t.error = '请填写答复，或关联材料/明确跳过文献。'; render(); return; }
    t.loading = true; t.error = ''; render();
    try {
      const paperDecisions = t.run.selected.filter(p => t.choices[p.id] || t.skip[p.id]).map(p => ({ paperId: p.id, inputName: t.choices[p.id] || null, skip: !!t.skip[p.id] }));
      const answer = t.answer.trim();
      t.run = await request('/api/codex/literature/resume', { sessionId: saved[mod.id].sessionId, id: saved[mod.id].id, plan: mod.doc, answer, paperDecisions, confirm: true, ...modelOptions(mod) });
      if (answer) Store.appendMessage(mod.id, '文献流程补充答复：' + answer, 'user');
      t.answer = ''; t.choices = {}; t.skip = {}; void watch(mod.id);
    } catch (error) { t.error = error.message; }
    finally { t.loading = false; render(); }
  }
  async function upload(mod, input) {
    const t = state(mod.id); t.loading = true; t.error = ''; render();
    try {
      const sid = await root.CodexUI.session(mod.id);
      for (const file of input.files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ' 超过 20MB');
        const response = await fetch('/api/codex/upload?session=' + sid + '&group=material&name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'X-Workbench': '1' }, body: file });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || '材料上传失败');
      }
      if (saved[mod.id]?.id) { t.run = await request('/api/codex/literature/status?session=' + sid + '&id=' + saved[mod.id].id); }
      await root.CodexUI.refresh(mod.id);
    } catch (error) { t.error = error.message; }
    finally { t.loading = false; render(); }
  }
  async function handoff(mod) {
    const t = state(mod.id), run = t.run;
    t.loading = true; t.error = ''; render();
    try {
      if (mod.doc?.status !== 'approved' || mod.doc.content !== run.plan) throw new Error('方案已变化，请重新审核并开始新运行。');
      if (run.status !== 'completed' || !run.rowCount) throw new Error('还没有可交接的数据表');
      let clean = Store.getState().modules.find(m => m.type === 'clean-data');
      if (!clean) { Store.addModule('数据清洗'); clean = Store.getState().modules.find(m => m.type === 'clean-data'); }
      if (!clean) throw new Error('请建立数据清洗模块后交接');
      if (saved[mod.id].handoffId !== run.id) {
        const target = await root.CodexUI.session(clean.id);
        const result = await request('/api/codex/import-input', { sessionId: target, sourceSessionId: run.sessionId, names: [run.id + '/extracted-data.csv'], sourceGroup: 'output', confirm: true });
        root.CodexUI.setInputBatch(clean.id, { names: result.names, label: '文献数据提取：人工确认批次 ' + run.id.slice(0, 8), text: run.plan });
        saved[mod.id].handoffId = run.id; persist();
        Store.confirmRun(mod.id);
        if (mod.type === 'download-data') Store.approveModule(mod.id);
        Store.appendMessage(clean.id, '已接收人工确认的文献提取 CSV。出处、原始材料及核查记录仍保存在上游文献获取模块；空值与 not_found 不代表零，按单独确认的清洗规则处理。批次：' + run.id, 'system');
        await root.CodexUI.refresh(clean.id);
      }
      Store.selectModule(clean.id);
    } catch (error) { t.error = error.message; }
    finally { t.loading = false; render(); }
  }
  function button(label, action, disabled, primary) { const el = node('button', label, primary ? 'primary-button' : 'quiet-button'); el.type = 'button'; el.disabled = !!disabled; el.onclick = action; return el; }
  function render() {
    const mod = active(); panel.hidden = !supported(mod) || !document.getElementById('records-view').hidden;
    if (panel.hidden) return;
    const t = state(mod.id), run = t.run;
    const handedOff = !!run && saved[mod.id]?.handoffId === run.id;
    if (!t.initialized && saved[mod.id]?.id) { t.initialized = true; void watch(mod.id); }
    panel.replaceChildren();
    const head = node('div', undefined, 'literature-actions');
    head.append(node('h3', '按方案获取文献数据'), node('span', handedOff ? '已人工确认并交接' : run ? statusNames[run.status] : '审核方案后可执行', 'codex-status')); panel.append(head);
    panel.append(node('p', '首批最多检索 20 条候选、处理 3 篇文献。按方案检索 Europe PMC / Crossref / Google Scholar，获取开放全文或读取你上传的材料；提取数据并保留出处。Scholar 如需验证，会暂停等待你操作。', 'codex-status'));
    const actions = node('div', undefined, 'literature-actions');
    actions.append(button(run ? '按当前审核方案开始新一批' : '按审核方案开始执行', () => start(mod), t.loading || run?.status === 'running' || mod.doc?.status !== 'approved', true));
    if (!run && mod.doc?.status !== 'approved') actions.append(node('span', '先在下方方案卡片审核通过，再开始。', 'codex-status'));
    if (run) actions.append(button('刷新状态', () => { t.error = ''; void watch(mod.id); }, t.loading || t.watching));
    if (run?.status === 'running' || run?.status === 'waiting') actions.append(button('停止本批执行', async () => { try { t.run = await request('/api/codex/literature/cancel', { sessionId: run.sessionId, id: run.id }); render(); } catch (error) { t.error = error.message; render(); } }, t.loading));
    panel.append(actions);
    if (run) {
      const stages = node('ol', undefined, 'literature-stages');
      const keys = Object.keys(stageNames), index = keys.indexOf(run.stage);
      keys.forEach((key, i) => { const step = node('li', (handedOff || i < index ? '✓ ' : i === index ? '● ' : '') + stageNames[key]); step.setAttribute('data-current', String(!handedOff && i === index)); stages.append(step); }); panel.append(stages);
      panel.append(node('p', handedOff ? '本批已人工确认并交给数据清洗；原件和出处记录保留在此。' : run.progress));
      panel.append(node('p', '候选 ' + run.candidateCount + ' 篇 · 入选 ' + run.selected.length + ' 篇 · 提取记录 ' + run.rowCount + ' 行（含需核查的空值）', 'codex-status'));
      if (mod.doc?.content !== run.plan || mod.doc?.status !== 'approved') panel.append(node('p', '当前方案与本批审核版本不同；本批仍按冻结方案运行，变更请重新审核并开始新一批。', 'codex-error'));
      if (run.status === 'waiting') {
        const box = node('div', undefined, 'literature-question'); box.append(node('h4', '需要与你讨论'));
        const list = node('ul'); run.questions.forEach(q => list.append(node('li', q))); box.append(list);
        const input = node('textarea'); input.rows = 4; input.maxLength = 5000; input.setAttribute('aria-label', '文献流程补充答复'); input.placeholder = '可以先在下方与 AI 讨论，确定后把决定写在这里，例如调整检索式、明确单位，或允许未找到的数据保留为空。'; input.value = t.answer; input.oninput = () => { t.answer = input.value; }; box.append(input);
        if (['acquire', 'extract'].includes(run.stage)) {
          const uploadInput = node('input'); uploadInput.type = 'file'; uploadInput.multiple = true; uploadInput.accept = '.pdf,.xml,.txt,.md,.csv,.tsv,.xlsx,.zip'; uploadInput.setAttribute('aria-label', '上传文献全文或补充材料'); uploadInput.disabled = t.loading; uploadInput.onchange = () => upload(mod, uploadInput); box.append(uploadInput);
          const materials = run.files.filter(f => f.group === 'material');
          run.selected.forEach(paper => {
            const label = node('label', paper.title, 'literature-material-row');
            const select = node('select'); select.setAttribute('aria-label', '关联材料：' + paper.title);
            const empty = node('option', '沿用已获取材料 / 暂未关联'); empty.value = ''; select.append(empty);
            materials.forEach(f => { const option = node('option', f.name.replace(/^[0-9a-f]{8}-/, '')); option.value = f.name; select.append(option); }); select.value = t.choices[paper.id] || ''; select.onchange = () => { t.choices[paper.id] = select.value; }; label.append(select);
            const skipLabel = node('label', '本轮跳过此篇（保留缺失记录）'); const skip = node('input'); skip.type = 'checkbox'; skip.checked = !!t.skip[paper.id]; skip.onchange = () => { t.skip[paper.id] = skip.checked; }; skipLabel.prepend(skip); label.append(skipLabel); box.append(label);
          });
        }
        box.append(button(run.scholarVerification ? '验证后继续执行' : '提交答复并继续执行', () => resume(mod), t.loading || mod.doc?.status !== 'approved', true)); panel.append(box);
      }
      if (run.status === 'completed') panel.append(button(saved[mod.id]?.handoffId === run.id ? '查看已交接的清洗模块' : '核查通过，将提取表交给清洗', () => handoff(mod), t.loading || !run.rowCount, true));
      if (run.artifacts.length) {
        const files = node('details'); files.open = ['waiting', 'completed'].includes(run.status); files.append(node('summary', '本批材料与成果 · ' + run.artifacts.length));
        const list = node('div', undefined, 'literature-files');
        run.artifacts.filter(f => !/run-state\.(json|tmp)$/.test(f.name)).forEach(f => { const link = node('a', f.name.slice(run.id.length + 1) + ' · ' + Math.ceil(f.size / 1024) + 'KB'); link.href = '/api/codex/download?session=' + run.sessionId + '&group=output&name=' + encodeURIComponent(f.name); list.append(link); }); files.append(list); panel.append(files);
      }
    }
    if (t.error) panel.append(node('p', t.error, 'codex-error'));
  }
  root.LiteratureUI = { render, start, isBusy: () => Object.values(states).some(t => t.loading || t.run?.status === 'running'), context: id => { const run = state(id).run; return run ? '当前文献获取状态：' + statusNames[run.status] + '；步骤：' + stageNames[run.stage] + '。待讨论问题：' + (run.questions || []).join('；') + '。对话只讨论，点击答复并继续才续跑。' : ''; } };
  Store.subscribe(render); render();
})(window);
