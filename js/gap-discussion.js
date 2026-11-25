(function (root) {
  'use strict';

  const sessions = new Map();
  const inFlight = new Set();
  const storageKey = (...ids) => 'research_gap_discussion_v1/' + JSON.stringify(ids);
  function read(key) {
    const raw = root.localStorage.getItem(key);
    if (!raw) return { turns: [], judgments: [] };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.turns) || !Array.isArray(data.judgments)) throw new Error('讨论记录格式异常。');
    return data;
  }
  function update(key, change) {
    const data = read(key);
    change(data);
    root.localStorage.setItem(key, JSON.stringify(data));
  }
  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value != null) node.textContent = value;
    return node;
  }
  function btn(label, cls, click) {
    const node = el('button', 'quiet-button ' + cls, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }
  function notesList(gap) {
    const list = el('ul', 'gd-basis');
    for (const entry of gap.basis || []) {
      const item = el('li');
      const label = '[' + (entry.id || '缺编号') + '] ';
      if (!entry.matched) {
        item.append(el('span', 'gd-missing', label + (entry.reason || '未找到对应论文笔记')));
      } else {
        item.append(el('strong', '', label + entry.title), el('span', 'gd-level', entry.evidence));
        if (entry.evidence === '全文') {
          if (entry.what) item.append(el('p', '', '调研归纳 · ' + entry.what));
          if (entry.conclusion && entry.conclusion !== '文中未说明') item.append(el('p', '', '论文笔记 · ' + entry.conclusion));
          if (entry.limitation && entry.limitation !== '文中未说明') item.append(el('p', '', '局限 · ' + entry.limitation));
        } else item.append(el('p', '', '当前只有题录，需回查全文。'));
      }
      list.append(item);
    }
    if (!list.children.length) list.append(el('li', 'gd-missing', '该空白尚无可对应的论文笔记。'));
    return list;
  }
  function renderHistory(records) {
    const list = el('div', 'gd-history');
    for (const turn of records.turns) {
      list.append(el('p', 'gd-user', '研究者 · ' + turn.question));
      list.append(el('p', 'gd-reply', turn.reply ? (turn.modelLabel || '助手') + ' · ' + turn.reply : '尚未收到答复'));
    }
    return list;
  }
  function fillQuestion(ui, gap, key, records, container) {
    const drafts = ui.drafts;
    const draft = drafts.get(key) || {};
    drafts.set(key, draft);
    const label = el('label', 'gd-field', '追问或补充解释');
    const field = el('textarea', 'gd-question');
    field.placeholder = '例如：除了样本量，还有哪些解释？哪篇论文的数据能帮助区分？';
    field.maxLength = 2000;
    field.value = draft.question || '';
    field.addEventListener('input', () => { draft.question = field.value; });
    label.append(field);
    const busy = inFlight.has(key);
    const last = records.turns[records.turns.length - 1];
    const controls = el('div', 'gd-actions');
    const send = btn(busy ? '正在回复…' : '发送追问', 'gd-send', () => sendQuestion(ui, gap, key, draft, field.value.trim()));
    send.disabled = busy;
    controls.append(send);
    if (!busy && last && !last.reply) controls.append(btn('重试上一条', 'gd-retry', () => sendQuestion(ui, gap, key, draft, last.question, last.id)));
    container.append(label, controls);

    const latest = records.judgments[records.judgments.length - 1];
    const judgmentLabel = el('label', 'gd-field', '我的最终判断');
    const judgment = el('textarea', 'gd-judgment');
    judgment.placeholder = '记录你决定采纳的解释、保留的疑问或需要补查的材料';
    judgment.maxLength = 4000;
    judgment.value = draft.judgment ?? latest?.text ?? '';
    judgment.addEventListener('input', () => { draft.judgment = judgment.value; });
    judgmentLabel.append(judgment);
    const save = btn('保存判断', 'gd-save', () => {
      const value = judgment.value.trim();
      if (!value) { ui.error = '请先填写你的判断。'; return paint(ui); }
      try {
        update(key, data => {
          const previous = data.judgments[data.judgments.length - 1];
          if (value !== previous?.text) data.judgments.push({ text: value, at: new Date().toISOString() });
        });
        delete draft.judgment;
        ui.error = ''; ui.notice = '已保存你的判断。';
      } catch (_) { ui.error = '本机未能保存判断，请复制文字后重试。'; }
      paint(ui);
    });
    container.append(judgmentLabel, save);
    if (records.judgments.length > 1) {
      const versions = el('details', 'gd-versions');
      versions.append(el('summary', '', '查看此前判断'));
      for (const old of records.judgments.slice(0, -1)) versions.append(el('p', '', old.at.slice(0, 10) + ' · ' + old.text));
      container.append(versions);
    }
  }

  async function sendQuestion(ui, gap, key, draft, question, retryId) {
    if (inFlight.has(key)) return;
    if (!question) { ui.error = '请先填写追问或解释。'; return paint(ui); }
    const id = retryId || (root.crypto.randomUUID ? root.crypto.randomUUID() :
      Array.from(root.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join('-'));
    const options = ui.options;
    const selected = () => ui.selected === gap.id;
    let history;
    try {
      update(key, data => {
        if (retryId && !data.turns.some(item => item.id === retryId && !item.reply)) throw new Error();
        history = data.turns.filter(item => item.id !== id && item.reply).slice(-4)
          .flatMap(item => [{ role: 'user', text: item.question }, {role: 'assistant', text: item.reply}]);
        if (!retryId) data.turns.push({ id, at: new Date().toISOString(), question, reply: '' });
      });
    } catch (_) { ui.error = '本机未能保存这条追问，请保留文字后重试。'; return paint(ui); }
    inFlight.add(key);
    if (!retryId) draft.question = '';
    ui.error = ''; ui.notice = '';
    paint(ui);
    try {
      const result = await options.post('/api/research/gap-discussion', {
        ...(options.modelFields ? options.modelFields() : {}), jobId: options.jobId, gapId: gap.id, question, history
      });
      if (!result || typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('未收到讨论答复。');
      try {
        update(key, data => {
          const turn = data.turns.find(item => item.id === id);
          if (!turn) throw new Error();
          turn.reply = result.reply;
          if (result.config) turn.modelLabel = [result.config.provider, result.config.model].filter(Boolean).join(' / ');
        });
      } catch (_) {
        draft.unsaved = result.reply;
        throw new Error('收到答复，但本机未能保存。请复制下方答复。');
      }
    } catch (error) { if (selected()) ui.error = error.message || '发送失败，请重试。'; }
    finally { inFlight.delete(key); paint(ui); }
  }

  function paint(ui) {
    const { panel, options } = ui;
    panel.replaceChildren();
    if (!options.jobId || !options.taskId) {
      panel.append(el('p', 'gd-muted', '文献调研产生作业后，可在这里讨论已保存的研究空白。'));
      return;
    }
    const open = btn(ui.loading ? '正在读取研究空白…' : ui.open ? '重新读取空白清单' : '讨论这条研究空白', 'gd-open', async () => {
      if (ui.loading) return;
      ui.loading = true; ui.error = ''; ui.notice = '';
      paint(ui);
      try {
        const data = await options.get('/api/research/gap-discussion?jobId=' + encodeURIComponent(options.jobId));
        if (!data || !Array.isArray(data.gaps)) throw new Error('空白清单格式异常。');
        ui.gaps = data.gaps; ui.open = true; ui.sourceNotice = data.notice || '';
        if (!ui.gaps.find(item => item.id === ui.selected)) ui.selected = ui.gaps[0]?.id || '';
      } catch (error) { ui.error = error.message || '读取研究空白失败。'; }
      finally { ui.loading = false; paint(ui); }
    });
    open.disabled = ui.loading;
    const header = el('div', 'gd-heading');
    header.append(el('h3', '', '研究空白讨论'), open);
    panel.append(header);
    if (ui.error || ui.notice) {
      const notice = el('p', ui.error ? 'gd-error' : 'gd-muted', ui.error || ui.notice);
      notice.setAttribute('role', ui.error ? 'alert' : 'status');
      panel.append(notice);
    }
    if (!ui.open) return;
    if (ui.sourceNotice) panel.append(el('p', 'gd-muted', ui.sourceNotice));
    if (!ui.gaps.length) return;
    const label = el('label', 'gd-field', '选择研究空白');
    const select = el('select', 'gd-select');
    for (const item of ui.gaps) {
      const option = el('option', '', item.gap);
      option.value = item.id; select.append(option);
    }
    select.value = ui.selected;
    select.addEventListener('change', () => {
      ui.selected = select.value;
      try { root.sessionStorage.setItem(ui.selectionKey, ui.selected); } catch (_) {}
      ui.notice = ''; ui.error = ''; paint(ui);
    });
    label.append(select);
    const gap = ui.gaps.find(item => item.id === ui.selected);
    panel.append(label);
    if (!gap) return;
    if (gap.direction) panel.append(el('p', 'gd-direction', '可检验方向 · ' + gap.direction));
    panel.append(notesList(gap));
    const key = storageKey(options.taskId, options.jobId, gap.id);
    let records;
    try { records = read(key); }
    catch (_) { panel.append(el('p', 'gd-error', '本机讨论记录无法读取。请先检查浏览器存储。')); return; }
    panel.append(renderHistory(records));
    const lostReply = ui.drafts.get(key)?.unsaved;
    if (lostReply) panel.append(el('p', 'gd-reply', '待复制答复 · ' + lostReply));
    fillQuestion(ui, gap, key, records, panel);
  }

  function build(mod, options) {
    if (!options || !['literature', 'question'].includes(mod?.step)) return null;
    const scope = storageKey(options.taskId, options.jobId);
    let ui = sessions.get(scope);
    if (!ui) {
      const selectionKey = 'research_gap_selection_v1/' + JSON.stringify([options.taskId, options.jobId]);
      let selected = '';
      try { selected = root.sessionStorage.getItem(selectionKey) || ''; } catch (_) {}
      ui = { drafts: new Map(), gaps: [], selected, selectionKey, open: false };
      sessions.set(scope, ui);
    }
    ui.options = options;
    ui.panel = el('section', 'gap-discussion');
    ui.panel.setAttribute('aria-label', '研究空白讨论');
    paint(ui);
    return ui.panel;
  }
  root.GapDiscussion = { build };
})(window);
