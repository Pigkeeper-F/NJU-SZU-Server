(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DownloadProfessionalRules = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // Deterministic compilation of the table the researcher sees and approves.
  // No model, eval, defaults for scientific thresholds, or execution permission.
  const HEADERS = ['编号', '检查字段', '检查方法', '通过条件', '适用条件', '依据'];
  const METHODS = { '必需字段': 'required_columns', '非空': 'not_empty', '允许值': 'allowed_values', '数值范围': 'numeric_range', '唯一键': 'unique_key', '记录数': 'row_count', '人工判断': 'manual' };
  const clean = value => String(value || '').trim().replace(/^`([^`]+)`$/, '$1');
  const list = value => clean(value).split(/[、；;]/).map(clean).filter(Boolean);
  const pending = value => /待讨论|待确认|待定|未定|待补|例如|示例|候选/.test(value);
  function manual(id, text, reason, basis) {
    return { id, label: '专业规则需确认', kind: 'manual', basis: basis || '已审核方案中的专业规则尚不能完整自动执行', sourceText: text, reason };
  }
  function cells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean); }
  function conditions(text) {
    if (['全部', '所有记录', '不限定', '-', '—'].includes(text)) return {};
    const result = {};
    for (const part of text.split(/[；;]/)) {
      const match = /^([^=<>!]+?)\s*=\s*(.+)$/.exec(part.trim());
      if (!match || result[clean(match[1])] || !list(match[2]).length) throw Error('适用条件尚不能按明确的字段等值条件执行');
      result[clean(match[1])] = list(match[2]);
    }
    return result;
  }
  function bounds(text, integer) {
    const result = {};
    for (const part of text.split(/[；;]/)) {
      const match = /^(最小|最大)\s*=\s*(\S+)$/.exec(part.trim());
      if (!match) throw Error('上下限尚未明确；需说明最小值或最大值及依据');
      const key = match[1] === '最小' ? 'min' : 'max', value = match[2];
      if (Object.hasOwn(result, key) || value.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)) || integer && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw Error('上下限数值不明确或不适用于记录数');
      result[key] = value;
    }
    if (!Object.keys(result).length || result.min !== undefined && result.max !== undefined && Number(result.min) > Number(result.max)) throw Error('上下限为空或相互冲突');
    return result;
  }
  function compile(plan) {
    const text = String(plan || ''), lines = text.split(/\r?\n/), rules = [], sections = [];
    let outerFence = null;
    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*(```|~~~)/.exec(lines[i]);
      if (fence) { outerFence = outerFence === fence[1] ? null : outerFence || fence[1]; continue; }
      if (outerFence) continue;
      const heading = /^\s*(#{1,6})\s+专业核验规则(?:\s*[（(][^）)]*[）)])?\s*$/.exec(lines[i]);
      if (!heading) continue;
      let end = i + 1;
      while (end < lines.length) { const next = /^\s*(#{1,6})\s+/.exec(lines[end]); if (next && next[1].length <= heading[1].length) break; end++; }
      sections.push({ body: lines.slice(i + 1, end), pending: pending(lines[i]) }); i = end - 1;
    }
    if (!sections.length) return { schema: 1, state: 'unspecified', rules: [manual('professional-unspecified', '', '本方案尚未列明专业核验规则，请讨论是否需要补充；未把通用文件检查当作专业核验。')] };
    if (sections.length !== 1) return { schema: 1, state: 'ambiguous', rules: [manual('professional-sections', text, '存在多份专业规则章节，需合并为当前有效的一份，不能猜测适用版本。')] };
    if (sections[0].pending) return { schema: 1, state: 'needs_discussion', rules: [manual('professional-candidate', sections[0].body.join('\n'), '专业规则仍标为候选或待确认，未自动转为执行标准。')] };
    const body = sections[0].body.filter(line => line.trim());
    const none = body.length === 1 && /^本任务无额外专业规则[。；;]\s*依据[：:]\s*(.+)$/.exec(body[0].trim());
    if (none && !pending(none[1])) return { schema: 1, state: 'none', rationale: none[1], rules: [] };
    let headerFound = false, inFence = false, index = 0;
    for (const line of body) {
      index++;
      if (/^\s*```/.test(line)) { inFence = !inFence; rules.push(manual('professional-text-' + index, line, '规则仍放在示例或代码块中，不能作为已明确的检查项执行。')); continue; }
      const row = cells(line);
      if (!inFence && row.length === HEADERS.length && row.every((value, i) => value === HEADERS[i])) { headerFound = true; continue; }
      if (!inFence && headerFound && row.length === HEADERS.length && row.every(value => /^:?-{3,}:?$/.test(value))) continue;
      if (inFence || !headerFound || row.length !== HEADERS.length || !/^\s*\|/.test(line)) { rules.push(manual('professional-text-' + index, line, '该专业要求尚未转成完整的检查规则，未忽略正文要求或自动猜测。')); continue; }
      const [givenId, field, method, condition, applies, basis] = row;
      const id = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(givenId) ? givenId : 'professional-row-' + index;
      try {
        if (id !== givenId || !basis || /^(无|暂无|不详|-|—)$/.test(basis) || !field || !applies || !condition || pending(row.join(' '))) throw Error('规则编号、字段、条件或依据尚未明确，需先讨论确认');
        const kind = METHODS[method]; if (!kind) throw Error('此检查方法暂未支持自动执行');
        const rule = { id, label: field + ' · ' + method, kind, basis, sourceText: line, when: conditions(applies) };
        if (kind === 'manual') { rule.reason = condition; rules.push(rule); continue; }
        if (kind === 'required_columns' || kind === 'unique_key') {
          rule.columns = list(field);
          if (!rule.columns.length || new Set(rule.columns).size !== rule.columns.length) throw Error('字段清单为空或重复');
          if (kind === 'required_columns' && !['全部存在', '均存在', '必须存在'].includes(condition) || kind === 'unique_key' && !['组合不重复', '不得重复', '不重复', '唯一'].includes(condition)) throw Error('通过条件尚不能准确转换为已支持检查');
        } else if (kind === 'row_count') {
          if (!['记录', '记录数', '全部记录', '-', '—', '*'].includes(field)) throw Error('记录数检查对象不明确，请说明适用记录范围');
          Object.assign(rule, bounds(condition, true));
        } else {
          if (list(field).length !== 1) throw Error('此检查需要一个明确字段，多个字段请分别写明规则');
          rule.column = field;
          if (kind === 'not_empty' && !['非空', '不得为空', '不为空'].includes(condition)) throw Error('非空检查的通过条件不明确');
          if (kind === 'allowed_values') { rule.allowed = list(condition); if (!rule.allowed.length) throw Error('尚未明确允许值'); }
          if (kind === 'numeric_range') Object.assign(rule, bounds(condition, false));
        }
        rules.push(rule);
      } catch (error) { rules.push(manual(id, line, error.message, basis)); }
    }
    if (!rules.length) rules.push(manual('professional-empty', body.join('\n'), '专业规则章节为空；请明确规则或说明无需额外规则的依据。'));
    const counts = new Map(); rules.forEach(rule => counts.set(rule.id, (counts.get(rule.id) || 0) + 1));
    rules.forEach((rule, i) => { if (counts.get(rule.id) > 1) rules[i] = manual(rule.id + '-duplicate-' + i, rule.sourceText, '规则编号重复，无法可靠对应检查与决定记录。', rule.basis); });
    if (rules.length > 200) return { schema: 1, state: 'ambiguous', rules: [manual('professional-limit', body.join('\n'), '规则超过单批200条，需要分组核验，未跳过超出条目。')] };
    return { schema: 1, state: rules.some(rule => rule.kind === 'manual') ? 'needs_discussion' : 'compiled', rules };
  }
  return { compile };
});
