(function (root) {
  'use strict';

  const sessions = new Map();
  const fields = [
    { key: 'claim', label: '综述结论', rows: 2, required: true },
    { key: 'source', label: '文献题名或引文', required: true },
    { key: 'locator', label: '原文位置', hint: '例如：第 8 页，表 2', required: true },
    { key: 'excerpt', label: '原文摘录（选填）', rows: 2 },
    { key: 'url', label: '原文链接（选填）', hint: 'https://…' }
  ];
  let currentView;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text, onClick, variant) {
    const node = element('button', 're-button' + (variant ? ' ' + variant : ''), text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }

  function taskId() {
    return root.TaskManager && root.TaskManager.currentTaskId();
  }

  function refresh(view, focus) {
    // Store writes can synchronously rebuild the workspace, replacing the original panel.
    if (!currentView || currentView.key !== view.key || taskId() !== view.taskId) return;
    paint(currentView);
    if (focus) {
      const target = currentView.panel.querySelector(focus);
      if (target) target.focus();
    }
  }

  function startDraft(view, original, seed) {
    const values = {};
    fields.forEach(field => { values[field.key] = (original || seed || {})[field.key] || ''; });
    view.ui.draft = { values, original: original ? { ...original } : null };
    view.ui.error = '';
    view.ui.notice = '';
    view.ui.picker = null;
    view.ui.deleting = null;
    refresh(view, seed && values.claim ? '[name="locator"]' : '[name="claim"]');
  }

  function completeWrite(view, result) {
    view.ui.notice = '';
    if (!result || !result.ok) {
      view.ui.error = (result && result.reason) || '保存失败，请重试。';
      refresh(view, '[role="alert"]');
      return;
    }
    view.ui.draft = null;
    view.ui.deleting = null;
    view.ui.error = '';
    refresh(view, '.re-add');
  }

  function saveDraft(view) {
    const { original, values } = view.ui.draft;
    const entry = {};
    for (const field of fields) {
      entry[field.key] = values[field.key].trim();
      if (field.required && !entry[field.key]) {
        view.ui.error = '请填写' + field.label + '。';
        refresh(view, '[name="' + field.key + '"]');
        return;
      }
    }
    if (entry.url && !safeUrl(entry.url)) {
      view.ui.error = '请填写以 https:// 或 http:// 开头的原文链接。';
      refresh(view, '[name="url"]');
      return;
    }
    if (original) entry.id = original.id;
    entry.verified = Boolean(original && original.verifiedAt &&
      fields.every(field => entry[field.key] === (original[field.key] || '')));
    completeWrite(view, root.Store.saveReviewEvidence(view.mod.id, entry,
      { taskId: view.taskId, original }));
  }

  function editor(view) {
    const form = element('form', 're-editor');
    const draft = view.ui.draft;
    form.noValidate = true;
    form.setAttribute('aria-label', draft.original ? '编辑文献依据' : '添加文献依据');
    fields.forEach(field => {
      const label = element('label', 're-field re-field-' + field.key);
      const input = element(field.rows ? 'textarea' : 'input');
      input.name = field.key;
      input.value = draft.values[field.key];
      input.maxLength = root.Store.LIMITS.REVIEW_EVIDENCE[field.key];
      input.required = Boolean(field.required);
      if (field.rows) input.rows = field.rows;
      if (field.hint) input.placeholder = field.hint;
      if (field.key === 'url') input.type = 'url';
      input.addEventListener('input', () => { draft.values[field.key] = input.value; });
      label.append(element('span', '', field.label), input);
      form.append(label);
    });
    const controls = element('div', 're-actions');
    const save = element('button', 're-button re-primary', '保存依据');
    save.type = 'submit';
    controls.append(save, button('取消', () => {
      view.ui.draft = null;
      view.ui.error = '';
      refresh(view, '.re-add');
    }));
    form.append(controls);
    form.addEventListener('submit', event => { event.preventDefault(); saveDraft(view); });
    return form;
  }

  async function openPicker(view) {
    const picker = { loading: true, items: [] };
    view.ui.picker = picker;
    view.ui.error = '';
    view.ui.notice = '';
    view.ui.deleting = null;
    refresh(view);
    try {
      const result = await view.loadSuggestions();
      picker.items = Array.isArray(result) ? result : [];
    } catch (error) {
      if (view.ui.picker === picker) view.ui.error = error.message || '未能读取文献调研结果，请重试。';
    }
    if (view.ui.picker !== picker) return;
    if (!currentView || currentView.key !== view.key || taskId() !== view.taskId) {
      view.ui.picker = null;
      view.ui.error = '';
      return;
    }
    picker.loading = false;
    if (view.ui.error) view.ui.picker = null;
    refresh(view, '.re-picker select');
  }

  function sourcePicker(view) {
    const picker = view.ui.picker;
    const box = element('div', 're-picker');
    if (picker.loading || !picker.items.length) {
      const notice = element('span', '', picker.loading ? '正在读取文献调研结果…' : '文献调研中暂无可选记录。');
      notice.setAttribute('role', 'status');
      box.append(notice);
    } else {
      const label = element('label', '', '选择文献或调研要点');
      const select = element('select');
      const placeholder = element('option', '', '请选择…');
      placeholder.value = '';
      select.append(placeholder);
      picker.items.forEach((item, index) => {
        const option = element('option', '', [item.source, item.claim].filter(Boolean).join(' · '));
        option.value = String(index);
        select.append(option);
      });
      select.addEventListener('change', () => {
        if (select.value !== '') startDraft(view, null, picker.items[Number(select.value)]);
      });
      label.append(select);
      box.append(label);
    }
    box.append(button('关闭', () => { view.ui.picker = null; refresh(view, '.re-import'); }));
    return box;
  }

  function record(view, entry) {
    const card = element('article', 're-card');
    const heading = element('div', 're-card-heading');
    heading.append(element('h4', '', entry.claim),
      element('span', 're-status' + (entry.verifiedAt ? ' is-verified' : ''), entry.verifiedAt ? '已对照原文' : '待核对原文'));
    card.append(heading);
    const source = element('p', 're-source', entry.source);
    source.append(element('span', 're-locator', entry.locator));
    card.append(source);
    if (entry.excerpt) card.append(element('blockquote', 're-excerpt', entry.excerpt));
    const actions = element('div', 're-actions');
    const url = safeUrl(entry.url);
    if (url) {
      const link = element('a', 're-link', '打开原文');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    const deleting = view.ui.deleting;
    if (!view.ui.draft && !view.ui.picker && (!deleting || deleting.id === entry.id)) {
      const guard = { taskId: view.taskId, original: { ...entry } };
      if (deleting) {
        actions.append(element('span', 're-delete-prompt', '删除这条依据？'),
          button('确认删除', () => completeWrite(view,
            root.Store.removeReviewEvidence(view.mod.id, entry.id, { taskId: view.taskId, original: deleting })), 're-danger'),
          button('取消', () => { view.ui.deleting = null; view.ui.error = ''; refresh(view); }, 're-cancel-delete'));
      } else {
        actions.append(button(entry.verifiedAt ? '撤销核对' : '标记为已对照原文', () => completeWrite(view,
          root.Store.saveReviewEvidence(view.mod.id, { ...entry, verified: !entry.verifiedAt }, guard))));
        actions.append(button('编辑', () => startDraft(view, entry)), button('删除', () => {
          view.ui.deleting = guard.original;
          view.ui.error = '';
          view.ui.notice = '';
          refresh(view, '.re-cancel-delete');
        }));
      }
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  async function copyVerified(view) {
    if (taskId() !== view.taskId) return;
    const verified = root.Store.getReviewEvidence(view.mod.id).filter(item => item.verifiedAt);
    const text = verified.map(item => {
      const title = '文献：' + item.source;
      const position = '原文位置：' + item.locator;
      return [item.claim, title, position, safeUrl(item.url)].filter(Boolean).join('\n');
    }).join('\n\n');
    view.ui.notice = '';
    view.ui.error = '';
    if (!text) {
      view.ui.notice = '暂无已核对条目可复制。';
    } else {
      try {
        await root.navigator.clipboard.writeText(text);
        view.ui.notice = '已复制 ' + verified.length + ' 条已核对依据。';
      } catch (_) {
        view.ui.error = '未能写入剪贴板，请检查浏览器的剪贴板权限。';
      }
    }
    refresh(view, '.re-copy');
  }

  function paint(view) {
    const { panel, ui } = view;
    const records = root.Store.getReviewEvidence(view.mod.id);
    if (ui.deleting && !records.some(item => item.id === ui.deleting.id)) ui.deleting = null;
    const header = element('div', 're-header');
    header.append(element('h3', '', '综述结论与文献依据'));
    if (!ui.draft && !ui.deleting && !ui.picker) {
      const controls = element('div', 're-actions');
      if (view.mod.step === 'writing' && records.some(item => item.verifiedAt)) {
        controls.append(button('复制已核对条目', () => copyVerified(view), 're-copy'));
      }
      if (view.loadSuggestions) controls.append(button('从文献调研选取', () => openPicker(view), 're-import'));
      controls.append(button('添加依据', () => startDraft(view), 're-add'));
      header.append(controls);
    }
    panel.replaceChildren(header);
    if (ui.error) {
      const error = element('p', 're-error', ui.error);
      error.setAttribute('role', 'alert');
      error.tabIndex = -1;
      panel.append(error);
    } else if (ui.notice) {
      const notice = element('p', 're-empty', ui.notice);
      notice.setAttribute('role', 'status');
      panel.append(notice);
    }
    if (ui.picker) panel.append(sourcePicker(view));
    if (ui.draft) panel.append(editor(view));
    if (!records.length && !ui.draft) panel.append(element('p', 're-empty', '尚未添加文献依据。'));
    records.forEach(entry => panel.append(record(view, entry)));
  }

  function build(mod, options) {
    if (!mod || !['literature', 'writing'].includes(mod.step)) return null;
    const activeTask = taskId();
    if (!activeTask) return null;
    const key = JSON.stringify([activeTask, mod.id]);
    if (!sessions.has(key)) sessions.set(key, { draft: null, picker: null, deleting: null, error: '' });
    const panel = element('section', 'review-evidence-panel');
    panel.setAttribute('aria-label', '综述结论与文献依据');
    currentView = { key, taskId: activeTask, mod, ui: sessions.get(key), panel, loadSuggestions: options && options.loadSuggestions };
    paint(currentView);
    return panel;
  }

  root.ReviewEvidencePanel = { build };
})(window);
