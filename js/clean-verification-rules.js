(function (root, factory) {
  'use strict';
  const dependency = typeof module === 'object' && module.exports ? require('./download-professional-rules') : root.DownloadProfessionalRules;
  const api = factory(dependency);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CleanVerificationRules = api;
})(typeof window !== 'undefined' ? window : this, function (professional) {
  'use strict';
  // Compile only what the researcher can see in the approved plan. No eval,
  // scientific threshold inference, data access, or execution authorization.
  const HEADERS = ['编号', '检查字段', '检查方法', '通过条件', '适用条件', '依据'];
  const MANUAL_HEADERS = ['编号', '核验内容', '检查方法', '通过条件', '必需', '依据'];
  const MANUAL_RULE_TERM = /人工(?:核验|核查|检查|复核|验收)(?:的)?(?:标准|规则|要求)/;
  const VALUE_METHODS = { '原值保留': 'copy', '去空格': 'trim', '名称映射': 'map', '数值换算': 'affine', '完全重复去重': 'duplicate', '人工判断': 'manual' };
  const PENDING = /待讨论|待确认|待定|未定|待补|例如|示例|候选/;
  const INTRO = '以下三节由智能体根据清洗需求整理，与同一份清洗方案一起讨论确认；研究者无需手填技术配置。自动规则与人工标准分开，未明确的行保留待讨论，不代表规则已经确定。';
  const clean = value => String(value == null ? '' : value).trim().replace(/^`([^`]+)`$/, '$1');
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
  const validBasis = value => !!value && !/^(无|暂无|不详|-|—)$/.test(value);
  const validId = value => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
  function pendingManualValue(value) {
    // Business objects such as pending records or candidate data are valid
    // things to review. Only explicit unknowns/placeholders mark a standard
    // unfinished; do not reuse the broader automatic-rule draft detector.
    const text = clean(value);
    return /待讨论|待确认|待定|未定|待明确|尚未确定|尚未明确/.test(text) ||
      /^待补(?:$|(?:充)?(?:依据|内容|核验内容|检查方法|方法|通过条件|条件|标准|编号|范围|规则|适用条件|文件名)(?:[：:\s]|$))/.test(text) ||
      /^(?:例如|示例|候选)(?:[：:，,、（(\s]|$)/.test(text) || /仅为示例|以下为示例/.test(text);
  }
  function manual(id, sourceText, reason, basis, inputColumn, outputColumn) {
    return { id, kind: 'manual', inputColumn: inputColumn || '', outputColumn: outputColumn || '', basis: basis || '已确认清洗方案中的要求尚不能完整自动核对', sourceText, reason };
  }
  function checkManual(id, sourceText, reason, basis) {
    return { id, label: '清洗核验规则需确认', kind: 'manual', basis: basis || '清洗方案中的专业要求尚不能完整自动核验', sourceText, reason };
  }
  function manualCheck(id, sourceText, reason, values) {
    const value = values || {};
    return { id, label: value.label || '人工核验标准需补充', method: value.method || '', condition: value.condition || '', required: true, basis: value.basis || '', sourceText, reason };
  }
  function headings(lines) {
    const result = []; let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index]);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
      if (heading) result.push({ start: index, level: heading[1].length, title: heading[2] });
    }
    result.forEach((entry, index) => {
      const next = result.slice(index + 1).find(other => other.level <= entry.level);
      entry.end = next ? next.start : lines.length;
    });
    return result;
  }
  function sections(lines, allHeadings, name) {
    const regex = new RegExp('^' + name + '(?:\\s*[（(]([^）)]*)[）)])?\\s*$');
    return allHeadings.filter(entry => regex.test(entry.title)).map(entry => ({ ...entry, sourceText: lines.slice(entry.start, entry.end).join('\n'), body: lines.slice(entry.start + 1, entry.end), pending: PENDING.test(entry.title) }));
  }
  function literal(value) {
    const text = clean(value);
    const quote = text[0];
    if ((quote === '"' || quote === "'") && text[text.length - 1] === quote && text.length >= 2) return text.slice(1, -1);
    if (quote === '"' || quote === "'") throw Error('带引号的原始取值未完整表达，不能推测分隔符含义');
    return text;
  }
  function conditions(text) {
    if (['全部', '所有记录', '不限定', '-', '—'].includes(text)) return {};
    const result = {};
    for (const part of text.split(/[；;]/)) {
      const match = /^([^=<>!]+?)\s*=\s*(.+)$/.exec(part.trim());
      if (!match) throw Error('适用条件只能使用源原始字段的明确等值条件，不能推测其他条件');
      const column = clean(match[1]);
      const values = match[2].split('、').map(literal);
      if (!column || Object.hasOwn(result, column) || values.some(value => !value.length) || new Set(values).size !== values.length || /\s(?:AND|OR)\s/i.test(match[2])) throw Error('适用条件字段或取值含糊、重复，不能自动判断');
      Object.defineProperty(result, column, { value: values, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  function fields(text) {
    const parts = text.split(/→|->/).map(clean);
    if (parts.length > 2 || parts.some(value => !value || /[、；;|\n]/.test(value))) throw Error('请明确一个输入字段与对应输出字段，不能猜测多个字段或步骤');
    return { inputColumn: parts[0], outputColumn: parts[1] || parts[0] };
  }
  function decimal(text, label, nonnegative) {
    const value = clean(text);
    if (value.length > 128 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || nonnegative && /^-/.test(value)) throw Error(label + '必须是明确' + (nonnegative ? '非负' : '') + '数值，不能使用表达式或默认科学阈值');
    return value; // Keep exact user text: never round through a JS Number.
  }
  function affine(text) {
    const result = {};
    for (const part of text.split(/[；;]/)) {
      const match = /^(乘|加|容差)\s*=\s*(.+)$/.exec(part.trim());
      if (!match) throw Error('数值换算须写明乘、可选加与绝对容差；不能执行任意公式');
      const key = { '乘': 'factor', '加': 'offset', '容差': 'absoluteTolerance' }[match[1]];
      if (Object.hasOwn(result, key)) throw Error('换算参数重复，需明确唯一公式');
      result[key] = decimal(match[2], match[1], key === 'absoluteTolerance');
    }
    if (!Object.hasOwn(result, 'factor')) throw Error('缺少明确乘数，不能推断换算公式');
    if (!Object.hasOwn(result, 'offset')) result.offset = '0';
    if (!Object.hasOwn(result, 'absoluteTolerance')) result.absoluteTolerance = '0';
    return result;
  }
  function mapping(text) {
    const result = {};
    for (const part of text.split(/[；;]/)) {
      const pieces = part.split(/→|->/);
      if (pieces.length !== 2 || !clean(pieces[0]) || !clean(pieces[1])) throw Error('名称映射须逐项写明原值→结果值，不能猜测缺失映射');
      const before = literal(pieces[0]), after = literal(pieces[1]);
      if (Object.hasOwn(result, before)) throw Error('同一原值存在多个映射，不能任选一个');
      Object.defineProperty(result, before, { value: after, enumerable: true, configurable: true, writable: true });
    }
    if (!Object.keys(result).length) throw Error('名称映射尚未明确');
    return result;
  }
  function compileValues(found) {
    if (!found.length) return { schema: 1, state: 'unspecified', rules: [manual('value-unspecified', '', '尚未列明原值与结果核对规则；改值、派生或新增字段不能自动视作正确。')] };
    if (found.length !== 1) return { schema: 1, state: 'ambiguous', rules: [manual('value-sections', found.map(value => value.sourceText).join('\n'), '存在多份原值与结果核对章节，需明确当前有效的一份。')] };
    const section = found[0], body = section.body.filter(line => line.trim());
    if (section.pending) return { schema: 1, state: 'needs_discussion', rules: [manual('value-candidate', section.sourceText, '原值与结果核对规则仍为候选或待确认，不能自动采用。')] };
    const none = body.length === 1 && /^仅保留原值，不进行改值[。；;]\s*依据[：:]\s*(.+)$/.exec(clean(body[0]));
    if (none && validBasis(clean(none[1])) && !PENDING.test(none[1])) return { schema: 1, state: 'none', rationale: clean(none[1]), rules: [] };
    const rules = []; let headerFound = false, fence = null;
    body.forEach((line, index) => {
      const textId = 'value-text-' + (index + 1), marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
        rules.push(manual(textId, line, '代码块或示例不能作为已确认的改值核对规则。')); return;
      }
      const row = cells(line);
      if (!fence && row.length === HEADERS.length && row.every((value, i) => value === HEADERS[i])) { headerFound = true; return; }
      if (!fence && headerFound && row.length === HEADERS.length && row.every(value => /^:?-{3,}:?$/.test(value))) return;
      if (fence || !headerFound || row.length !== HEADERS.length || !/^\s*\|/.test(line)) { rules.push(manual(textId, line, '原值与结果要求尚未整理为完整规则，未忽略或自动猜测。')); return; }
      const [givenId, field, method, condition, applies, basis] = row;
      const id = validId(givenId) ? givenId : 'value-row-' + (index + 1); let pair;
      try {
        if (id !== givenId || !field || !condition || !applies || !validBasis(basis) || PENDING.test(row.join(' '))) throw Error('规则编号、字段、条件或依据尚未明确，需先讨论确认');
        const kind = VALUE_METHODS[method]; if (!kind) throw Error('此原值与结果核对方法暂未支持；需明确规则或人工判断');
        if (kind === 'duplicate') {
          if (field !== '全部原字段' || condition !== '保留最早原始记录' || applies !== '全部') throw Error('去重判据或保留策略尚不能独立核对；当前仅支持同一原文件内全原字段相同并保留最早记录');
          rules.push({ id, kind, columns: ['*'], keep: 'first', when: {}, basis, sourceText: line }); return;
        }
        pair = fields(field);
        const rule = { id, kind, ...pair, when: conditions(applies), basis, sourceText: line };
        if (kind === 'manual') rule.reason = condition;
        else if (kind === 'copy' && !['不变', '原值不变', '保持原值', '与原值一致'].includes(condition)) throw Error('原值保留须明确不变，不能顺带推断其他处理');
        else if (kind === 'trim' && !['去前后空格', '仅去前后空格', '删除前后空格'].includes(condition)) throw Error('去空格只核对去除前后空格，不推断去除内部字符');
        else if (kind === 'map') rule.mapping = mapping(condition);
        else if (kind === 'affine') Object.assign(rule, affine(condition));
        rules.push(rule);
      } catch (error) { rules.push(manual(id, line, error.message, basis, pair && pair.inputColumn, pair && pair.outputColumn)); }
    });
    if (!rules.length) rules.push(manual('value-empty', section.sourceText, '原值与结果核对章节为空，请明确规则或明确仅保留原值及依据。'));
    return { schema: 1, state: rules.some(rule => rule.kind === 'manual') ? 'needs_discussion' : 'compiled', rules };
  }
  function compileManual(found) {
    // Existing plans have no implicit manual checklist. A standard only becomes
    // an applicable manual check when it is included in the confirmed plan.
    if (!found.length) return { schema: 1, state: 'none', rules: [] };
    if (found.length !== 1) return { schema: 1, state: 'needs_discussion', rules: [manualCheck('manual-sections', found.map(value => value.sourceText).join('\n'), '存在多份人工核验标准章节，需明确当前有效的一份。')] };
    const section = found[0], body = section.body.filter(line => line.trim());
    if (section.pending) return { schema: 1, state: 'needs_discussion', rules: [manualCheck('manual-candidate', section.sourceText, '人工核验标准仍为候选或待确认，不能自动采用。')] };
    const none = body.length === 1 && /^本任务无额外人工核验标准[。；;]\s*依据[：:]\s*(.+)$/.exec(clean(body[0]));
    if (none && validBasis(clean(none[1])) && !pendingManualValue(none[1])) return { schema: 1, state: 'none', rationale: clean(none[1]), rules: [] };
    const rules = []; let headerFound = false, fence = null;
    body.forEach((line, index) => {
      const textId = 'manual-text-' + (index + 1), marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
        rules.push(manualCheck(textId, line, '代码块或示例不能作为已确认的人工核验标准。')); return;
      }
      const row = cells(line);
      if (!fence && row.length === MANUAL_HEADERS.length && row.every((value, i) => value === MANUAL_HEADERS[i])) { headerFound = true; return; }
      if (!fence && headerFound && row.length === MANUAL_HEADERS.length && row.every(value => /^:?-{3,}:?$/.test(value))) return;
      if (fence || !headerFound || row.length !== MANUAL_HEADERS.length || !/^\s*\|/.test(line)) { rules.push(manualCheck(textId, line, '人工核验要求尚未整理为完整标准，未忽略或自动猜测。')); return; }
      const [givenId, label, method, condition, required, basis] = row;
      const id = validId(givenId) ? givenId : 'manual-row-' + (index + 1);
      const values = { label, method, condition, basis };
      if (id !== givenId || !label || !method || !condition || !validBasis(basis) || row.some(pendingManualValue)) { rules.push(manualCheck(id, line, '人工核验的编号、内容、方法、通过条件或依据尚未明确，需先讨论确认。', values)); return; }
      if (!['是', '否'].includes(required)) { rules.push(manualCheck(id, line, '必需须明确为“是”或“否”；未确认前按必需项保留，不能自动略过。', values)); return; }
      rules.push({ id, label, method, condition, required: required === '是', basis, sourceText: line });
    });
    if (!rules.length) rules.push(manualCheck('manual-empty', section.sourceText, '人工核验标准章节为空，请明确标准，或写明本任务无需额外人工核验及依据。'));
    return { schema: 1, state: rules.some(rule => rule.reason) ? 'needs_discussion' : 'specified', rules };
  }
  function compile(plan) {
    const text = String(plan || ''), lines = text.split(/\r?\n/), allHeadings = headings(lines);
    const checkSections = sections(lines, allHeadings, '清洗核验规则'), valueSections = sections(lines, allHeadings, '原值与结果核对'), manualSections = sections(lines, allHeadings, '人工核验标准');
    const normalized = checkSections.map(section => section.sourceText.replace(/^(\s*#{1,6}\s+)清洗核验规则/, '$1专业核验规则').replace(/^(\s*)~{3,}.*$/gm, '$1```')).join('\n\n');
    let checks = professional && typeof professional.compile === 'function' ? professional.compile(normalized) : { schema: 1, state: 'needs_discussion', rules: [checkManual('clean-compiler-unavailable', normalized, '专业规则编译器未加载，不能声称规则已经执行。')] };
    if (checks.state === 'none' && !validBasis(clean(checks.rationale))) checks = { schema: 1, state: 'needs_discussion', rules: [checkManual('clean-none-basis', normalized, '无需额外专业规则的依据尚未明确。')] };
    const valueRules = compileValues(valueSections);
    const manualChecks = compileManual(manualSections);
    const manualCovered = new Set();
    const coverManual = section => { for (let index = section.start; index < section.end; index++) manualCovered.add(index); };
    manualSections.forEach(coverManual);
    allHeadings.filter(section => !manualCovered.has(section.start) && MANUAL_RULE_TERM.test(section.title)).forEach(section => {
      manualChecks.rules.push(manualCheck('manual-other-section-' + (section.start + 1), lines.slice(section.start, section.end).join('\n'), '发现人工标准或规则的其他章节名称，请整理到“人工核验标准”节并确认，未丢弃原要求。'));
      coverManual(section);
    });
    const visibleHeadings = new Set(allHeadings.map(section => section.start));
    lines.forEach((line, index) => {
      if (visibleHeadings.has(index) || !/^\s*#{1,6}\s+/.test(line) || !MANUAL_RULE_TERM.test(line)) return;
      const end = lines.findIndex((candidate, candidateIndex) => candidateIndex > index && /^\s*(?:`{3,}|~{3,})/.test(candidate));
      manualChecks.rules.push(manualCheck('manual-fenced-' + (index + 1), lines.slice(index, end < 0 ? lines.length : end).join('\n'), '代码块中的人工标准仅作示例，需整理进同一方案并确认后才能采用。'));
      coverManual({ start: index, end: end < 0 ? lines.length : end });
    });
    const covered = new Set(); [...checkSections, ...valueSections, ...manualSections].forEach(section => { for (let i = section.start; i < section.end; i++) covered.add(i); });
    manualCovered.forEach(index => covered.add(index));
    allHeadings.filter(section => !covered.has(section.start) && /^(?:专业核验规则|清洗核验规则|原值与结果核对|原值核对规则|核验规则|核对规则|校验规则|人工核验标准)(?:[（(:：\s]|$)/.test(section.title)).forEach(section => {
      const sourceText = lines.slice(section.start, section.end).join('\n');
      if (/^人工核验标准/.test(section.title)) manualChecks.rules.push(manualCheck('manual-other-section-' + (section.start + 1), sourceText, '人工核验标准章节名称或版本尚未明确，需合并当前有效要求，未丢弃该章文本。'));
      else checks.rules.push(checkManual('clean-other-section-' + (section.start + 1), sourceText, '存在未归入指定三节的核验规则章节，需合并当前有效要求，未丢弃该章文本。'));
      for (let i = section.start; i < section.end; i++) covered.add(i);
    });
    // Requirements written elsewhere still need human reconciliation. Ordinary
    // plan goals/files/execution prose are not silently reinterpreted as rules.
    const requirement = /专业核验规则|清洗核验规则|原值与结果核对|人工核验标准|核(?:验|对|查)要求|检查规则|校验规则|重复判据|异常(?:值)?(?:删除|处理|判定)|缺失(?:值)?(?:填补|处理)|单位(?:换算|转换)|绝对容差|误差阈值|唯一键|允许值|不得改值|原值保留|保留原值|不进行改值/;
    lines.forEach((line, index) => {
      if (!manualCovered.has(index) && MANUAL_RULE_TERM.test(line)) {
        manualChecks.rules.push(manualCheck('manual-outside-' + (index + 1), line, '发现尚未归入标准章节的人工核验要求，请整理到“人工核验标准”节后确认采用。')); return;
      }
      if (covered.has(index) || !line.trim() || clean(line) === INTRO || !requirement.test(line) && !/\|\s*(?:必需字段|非空|数值范围|记录数|去空格|名称映射|数值换算|人工判断)\s*\|/.test(line)) return;
      if (/人工核验标准/.test(line)) manualChecks.rules.push(manualCheck('manual-outside-' + (index + 1), line, '人工核验要求写在指定章节之外，需合并进当前有效标准后才能采用。'));
      else checks.rules.push(checkManual('clean-outside-' + (index + 1), line, '此要求写在指定规则章节之外，需合并进当前有效规则后才能自动执行。'));
    });
    const all = [...checks.rules.map((rule, index) => ({ list: checks.rules, index, rule })), ...valueRules.rules.map((rule, index) => ({ list: valueRules.rules, index, rule })), ...manualChecks.rules.map((rule, index) => ({ list: manualChecks.rules, index, rule }))];
    const counts = new Map(); all.forEach(({ rule }) => counts.set(rule.id, (counts.get(rule.id) || 0) + 1));
    const reserved = new Set(all.map(({ rule }) => rule.id));
    all.forEach(({ list, index, rule }, n) => {
      if (counts.get(rule.id) > 1) {
        let id = rule.id + '-duplicate-' + n;
        while (reserved.has(id)) id += '-x';
        reserved.add(id);
        const reason = '规则编号重复，不能可靠关联核验与决定记录。';
        list[index] = list === checks.rules ? checkManual(id, rule.sourceText, reason, rule.basis) : list === manualChecks.rules ? manualCheck(id, rule.sourceText, reason, rule) : manual(id, rule.sourceText, reason, rule.basis, rule.inputColumn, rule.outputColumn);
      }
    });
    if (all.length > 200) {
      checks = { schema: 1, state: 'ambiguous', rules: [checkManual('clean-rule-limit', text, '单批规则超过200条，需明确分组，未跳过多余要求。')] };
      valueRules.rules = [manual('value-rule-limit', text, '单批规则超过200条，尚不能自动执行。')];
      if (manualChecks.rules.length) manualChecks.rules = [manualCheck('manual-rule-limit', text, '单批规则超过200条，需明确分组，不能跳过人工核验要求。')];
    }
    if (checks.rules.some(rule => rule.kind === 'manual')) checks.state = 'needs_discussion';
    if (valueRules.rules.some(rule => rule.kind === 'manual')) valueRules.state = 'needs_discussion';
    if (manualChecks.rules.some(rule => rule.reason)) manualChecks.state = 'needs_discussion';
    return { schema: 1, checks, valueRules, manualChecks };
  }
  function template() {
    return INTRO + '\n\n### 清洗核验规则\n\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| C01 | 待讨论 | 人工判断 | 待讨论本批重复、缺失、异常及单位规则 | 全部 | 待确认业务依据 |\n\n### 原值与结果核对\n\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n| V01 | 待讨论 | 人工判断 | 待讨论输入字段、输出字段及改值公式 | 全部 | 待确认业务依据 |\n\n### 人工核验标准\n\n| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n| M01 | 待讨论本批需人工核验的内容 | 待讨论人工查看的记录及证据 | 待讨论可明确判断的通过条件 | 是 | 待确认业务依据或附件：实际文件名 |';
  }
  function guidance() {
    return '由智能体读取本批输入并提出精简核验规则，与用户在同一份清洗方案中讨论确认；用户确认业务要求，无需手填技术配置。' +
      '在“### 清洗核验规则”和“### 原值与结果核对”各写一张六列表：编号、检查字段、检查方法、通过条件、适用条件、依据；说明放在规则章节之前，不把待讨论或示例当作已确认规则。' +
      '需要人工核验时，在同一方案添加“### 人工核验标准”六列表：编号、核验内容、检查方法、通过条件、必需、依据；写清人需要查看哪些记录或原件、怎么判断、满足什么才通过，必需只写“是”或“否”。人工标准由人作结论，不能因已列出标准或上传了附件就视为核验通过。依据可写“附件：实际文件名”，并在方案里说明采用其中哪些条款；上传本身不代表采用，须随方案讨论确认。没有额外人工标准可省略该节，或仅写“本任务无额外人工核验标准。依据：具体理由”。' +
      '专业检查支持必需字段、非空、允许值、数值范围、唯一键、记录数及人工判断；具体阈值、允许误差、重复判据、缺失填补与异常删除必须有确认依据，不自行编造。' +
      '原值核对写一个输入字段→输出字段，同名可只写字段名。原值保留对应“不变”；去空格对应“去前后空格”；名称映射写“原值→结果值；另一原值→结果值”；数值换算写“乘=明确数值；加=明确数值；容差=非负绝对容差”，至少明确乘数，未给加数按0，未给容差要求精确一致。' +
      '不得因两行数值相同就自动删观测。只有确认允许同一原文件内全行去重时，写“完全重复去重”、字段“全部原字段”、条件“保留最早原始记录”、适用“全部”及依据；其他业务键去重、跨文件保留顺序或冲突值选择写人工判断。' +
      '适用条件按源原始文本精确匹配：“字段=值1、值2；另一字段=值”表示同字段任选值、不同字段同时满足；“全部”表示所有记录。每条核对独立从原始值计算，不默认前一条规则的结果，不猜测多步顺序、统计汇总或派生公式。无法完整表达的写人工判断并说明缺项。' +
      '若确无额外专业规则，清洗核验规则节仅写“本任务无额外专业规则。依据：具体理由”；若确实不改值，原值与结果核对节仅写“仅保留原值，不进行改值。依据：具体理由”。这不放行未知新增或改值。' +
      '执行清洗时保留原始输入并生成材料清单与逐条去向、输入行到输出行对应关系；合并、拆分、删除或隔离须有原始记录及规则依据，以便独立核验。';
  }
  return { compile, template, guidance };
});
