'use strict';
// Synthetic text only: no real data, model, download, filesystem writes or clean run.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { compile, template, guidance } = require('../js/clean-verification-rules');
const table = '| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n';
const checkNone = '本任务无额外专业规则。依据：本合成测试专门核对原值改值关系。';
const valueNone = '仅保留原值，不进行改值。依据：本合成测试不进行数值或名称变换。';
const plan = (values, checks = checkNone) => '# 合成清洗方案\n\n### 清洗核验规则\n' + checks + '\n\n### 原值与结果核对\n' + (Array.isArray(values) ? table + values.join('\n') : values);
const row = (id, field, method, condition, applies = '全部', basis = '本合成测试已确认的字段约定') => `| ${id} | ${field} | ${method} | ${condition} | ${applies} | ${basis} |`;
const manualTable = '| 编号 | 核验内容 | 检查方法 | 通过条件 | 必需 | 依据 |\n|---|---|---|---|---|---|\n';
const manualRow = (id, label, method, condition, required = '是', basis = '本合成测试的业务定义') => `| ${id} | ${label} | ${method} | ${condition} | ${required} | ${basis} |`;
const withManual = (body, base = plan(valueNone)) => base + '\n\n### 人工核验标准\n' + (Array.isArray(body) ? manualTable + body.join('\n') : body);
const automatic = compile(plan([
  row('V01', 'record_id', '原值保留', '不变'),
  row('V02', 'raw_name→name', '去空格', '去前后空格'),
  row('V03', 'species→species_code', '名称映射', '肉鸡→broiler；牛→cattle'),
  row('V04', 'weight→weight_g', '数值换算', '乘=1000.000000000000000001；加=-0.00000000000000001；容差=0.000000000000000001', 'unit=kg；species=肉鸡、牛'),
  row('V05', 'rate→percent', '数值换算', '乘=1e+2')
], table + [
  row('C01', 'record_id、weight_g', '必需字段', '全部存在'),
  row('C02', 'record_id', '唯一键', '组合不重复'),
  row('C03', 'weight_g', '数值范围', '最小=0；最大=100000.000000000000001')
].join('\n')));
assert.equal(automatic.schema, 1);
assert.equal(automatic.checks.state, 'compiled');
assert.equal(automatic.valueRules.state, 'compiled');
assert.equal(automatic.checks.rules.length, 3);
assert.deepEqual(automatic.valueRules.rules.map(rule => rule.kind), ['copy', 'trim', 'map', 'affine', 'affine']);
assert.equal(automatic.valueRules.rules[0].inputColumn, 'record_id');
assert.equal(automatic.valueRules.rules[0].outputColumn, 'record_id');
assert.equal(automatic.valueRules.rules[1].inputColumn, 'raw_name');
assert.equal(automatic.valueRules.rules[1].outputColumn, 'name');
assert.deepEqual(automatic.valueRules.rules[2].mapping, { '肉鸡': 'broiler', '牛': 'cattle' });
assert.deepEqual(automatic.valueRules.rules[3].when, { unit: ['kg'], species: ['肉鸡', '牛'] });
assert.equal(automatic.valueRules.rules[3].factor, '1000.000000000000000001');
assert.equal(automatic.valueRules.rules[3].offset, '-0.00000000000000001');
assert.equal(automatic.valueRules.rules[3].absoluteTolerance, '0.000000000000000001');
assert.equal(automatic.valueRules.rules[4].factor, '1e+2');
assert.equal(automatic.valueRules.rules[4].offset, '0');
assert.equal(automatic.valueRules.rules[4].absoluteTolerance, '0', 'No tolerance supplied means exact; do not invent an error threshold');
assert.equal(automatic.checks.rules[2].max, '100000.000000000000001');
const noChanges = compile(plan(valueNone));
assert.equal(noChanges.checks.state, 'none'); assert.equal(noChanges.valueRules.state, 'none');
assert.deepEqual(noChanges.valueRules.rules, []);
assert.deepEqual(noChanges.manualChecks, { schema: 1, state: 'none', rules: [] }, 'Old plans must not gain invented manual standards');
const explicitManualNone = compile(withManual('本任务无额外人工核验标准。依据：本批输入仅进行已经确认的确定性换算。'));
assert.equal(explicitManualNone.manualChecks.state, 'none'); assert.equal(explicitManualNone.manualChecks.rules.length, 0);
const human = compile(withManual([
  manualRow('M01', '两个来源的统计口径是否相同', '逐项对照两个来源的定义、范围及原件页码', '定义和统计范围均一致；否则分别保留', '是', '附件：人工核验标准.docx 第2条'),
  manualRow('M02', '跨年变化说明', '核对变动来源的修订说明', '明确标明更改原因并关联原始说明', '否', '研究者确认的年度更新方案')
]));
assert.equal(human.manualChecks.state, 'specified');
assert.equal(human.checks.state, 'none'); assert.equal(human.valueRules.state, 'none', 'Manual standards must not silently become executable automatic rules');
assert.deepEqual(human.manualChecks.rules[0], { id: 'M01', label: '两个来源的统计口径是否相同', method: '逐项对照两个来源的定义、范围及原件页码', condition: '定义和统计范围均一致；否则分别保留', required: true, basis: '附件：人工核验标准.docx 第2条', sourceText: manualRow('M01', '两个来源的统计口径是否相同', '逐项对照两个来源的定义、范围及原件页码', '定义和统计范围均一致；否则分别保留', '是', '附件：人工核验标准.docx 第2条') });
assert.equal(human.manualChecks.rules[1].required, false);
assert.ok(human.manualChecks.rules.every(rule => !rule.reason && !Object.hasOwn(rule, 'status')), 'Listing a valid standard is not a manual approval');
const businessTerms = compile(withManual([
  manualRow('M01', '核验待补记录', '对照问题清单和原件', '待补项均列明原因且未混入主表', '是', '已确认材料处理规则'),
  manualRow('M02', '核对候选数据的去向', '对照候选数据清单及原始来源', '每条候选数据均有明确去向', '否', '已确认候选数据处理规则')
]));
assert.equal(businessTerms.manualChecks.state, 'specified', 'Pending records and candidate data are business terms, not unfinished standards');
assert.ok(businessTerms.manualChecks.rules.every(rule => !rule.reason));
assert.equal(compile(withManual('本任务无额外人工核验标准。依据：已确认候选数据均按自动规则处理。')).manualChecks.state, 'none');
for (const pendingRow of [
  manualRow('M01', '', '对照来源', '口径一致'),
  manualRow('M01', '来源口径', '', '口径一致'),
  manualRow('M01', '来源口径', '对照来源', ''),
  manualRow('M01', '来源口径', '对照来源', '口径一致', '是', ''),
  manualRow('M01', '来源口径', '对照来源', '口径一致', '可选'),
  manualRow('M01', '来源口径', '对照来源', '口径一致', ''),
  manualRow('M01', '待确认来源口径', '对照来源', '口径一致', '否'),
  manualRow('M01', '来源口径', '待补检查方法', '口径一致'),
  manualRow('M01', '待补内容', '对照来源', '口径一致'),
  manualRow('M01', '来源口径', '对照来源', '口径一致', '是', '待补依据'),
  manualRow('M01', '示例：来源口径', '对照来源', '口径一致'),
  manualRow('M01', '候选：来源口径', '对照来源', '口径一致'),
  manualRow('invalid id', '来源口径', '对照来源', '口径一致'),
  '| M01 | 来源口径 | 对照来源 | 口径一致 |'
]) {
  const pending = compile(withManual([pendingRow]));
  assert.equal(pending.manualChecks.state, 'needs_discussion', pendingRow);
  assert.ok(pending.manualChecks.rules.every(rule => rule.required && rule.reason && rule.sourceText.includes(pendingRow)), pendingRow);
}
assert.equal(compile(withManual('')).manualChecks.state, 'needs_discussion');
assert.equal(compile(withManual('本任务无额外人工核验标准。依据：-')).manualChecks.state, 'needs_discussion');
const pendingCandidate = withManual([manualRow('M01', '来源口径', '对照来源', '口径一致')]).replace('### 人工核验标准', '### 人工核验标准（候选）');
assert.equal(compile(pendingCandidate).manualChecks.state, 'needs_discussion');
const repeatManual = compile(withManual([manualRow('M01', '来源口径', '对照来源', '口径一致')]) + '\n\n### 人工核验标准\n' + manualTable + manualRow('M02', '另一标准', '对照原件', '符合原件'));
assert.equal(repeatManual.manualChecks.state, 'needs_discussion'); assert.ok(repeatManual.manualChecks.rules[0].sourceText.includes('M01') && repeatManual.manualChecks.rules[0].sourceText.includes('M02'));
const conflictingManualIds = compile(withManual([manualRow('C01', '来源口径', '对照来源', '口径一致'), manualRow('V01', '另一标准', '对照原件', '符合原件')], plan([row('V01', 'a', '原值保留', '不变')], table + row('C01', 'a', '非空', '非空'))));
assert.equal(conflictingManualIds.manualChecks.state, 'needs_discussion');
assert.ok(conflictingManualIds.manualChecks.rules.every(rule => rule.required && rule.reason.includes('编号重复')));
assert.ok(conflictingManualIds.checks.rules.every(rule => rule.kind === 'manual'));
assert.ok(conflictingManualIds.valueRules.rules.every(rule => rule.kind === 'manual'));
const manualIds = [...conflictingManualIds.checks.rules, ...conflictingManualIds.valueRules.rules, ...conflictingManualIds.manualChecks.rules].map(rule => rule.id);
assert.equal(new Set(manualIds).size, manualIds.length);
const repeatedHumanId = compile(withManual([manualRow('M01', '来源口径', '对照来源', '口径一致'), manualRow('M01', '另一个标准', '对照原件', '符合原件')]));
assert.equal(repeatedHumanId.manualChecks.state, 'needs_discussion'); assert.ok(repeatedHumanId.manualChecks.rules.every(rule => rule.required && rule.reason));
for (const fence of ['```', '~~~']) {
  const fencedHuman = compile(withManual(fence + '\n' + manualTable + manualRow('M01', '来源口径', '对照来源', '口径一致') + '\n' + fence));
  assert.equal(fencedHuman.manualChecks.state, 'needs_discussion'); assert.ok(fencedHuman.manualChecks.rules.every(rule => rule.required && rule.reason));
  const whollyFencedHuman = compile(plan(valueNone) + '\n' + fence + '\n### 人工核验标准\n' + manualTable + manualRow('M01', '来源口径', '对照来源', '口径一致') + '\n' + fence);
  assert.equal(whollyFencedHuman.manualChecks.state, 'needs_discussion');
}
const manualOutside = compile(plan(valueNone) + '\n\n### 附加要求\n人工核验标准：需要核对两来源统计口径。');
assert.equal(manualOutside.manualChecks.state, 'needs_discussion');
for (const alias of ['人工核查标准', '人工检查要求', '人工复核规则', '人工验收标准']) {
  const aliasBody = '两个来源的统计口径不同则分别保留。';
  const aliasPlan = compile(plan(valueNone) + '\n\n### ' + alias + '\n' + aliasBody);
  assert.equal(aliasPlan.manualChecks.state, 'needs_discussion', alias);
  assert.ok(aliasPlan.manualChecks.rules.some(rule => rule.required && rule.reason && rule.sourceText.includes(aliasBody)), alias);
}
const inlineHuman = compile(plan(valueNone) + '\n人工检查要求：不同统计口径的记录不得合并。');
assert.equal(inlineHuman.manualChecks.state, 'needs_discussion', 'An explicit manual standard sentence inside another section must not silently disappear');
const methodNarrative = compile(plan(valueNone) + '\n\n### 方法说明\n人工查看对照来源的界面，记录说明的位置。');
assert.equal(methodNarrative.manualChecks.state, 'none', 'Ordinary manual method prose without an explicit standard/rule/requirement term must not create a new requirement');
const duplicatePolicy = compile(plan([row('D01', '全部原字段', '完全重复去重', '保留最早原始记录')]));
assert.equal(duplicatePolicy.valueRules.rules[0].kind, 'duplicate'); assert.deepEqual(duplicatePolicy.valueRules.rules[0].columns, ['*']);
assert.equal(compile(plan([row('D01', 'id', '完全重复去重', '保留最早原始记录')])).valueRules.rules[0].kind, 'manual');
assert.equal(compile('旧方案只有目标与文件').checks.rules[0].kind, 'manual');
assert.equal(compile('旧方案只有目标与文件').valueRules.rules[0].kind, 'manual');
assert.ok(compile(template()).checks.rules.some(rule => rule.kind === 'manual'));
assert.ok(compile(template()).valueRules.rules.some(rule => rule.kind === 'manual'), 'A template is pending, not a confirmed rule');
assert.equal(compile(template()).manualChecks.state, 'needs_discussion', 'A manual template must remain unconfirmed');
assert.equal((template().match(/^### /gm) || []).length, 3);
assert.ok(template().indexOf('无需手填技术配置') < template().indexOf('### 清洗核验规则'));
assert.ok(guidance().includes('源原始文本'));
assert.ok(guidance().includes('逐条去向'));
assert.ok(guidance().includes('不默认前一条规则的结果'));
assert.ok(guidance().includes('上传本身不代表采用'));
assert.ok(guidance().includes('人工标准由人作结论'));
for (const badRow of [
  row('V01', 'weight', '数值换算', '加=1'),
  row('V01', 'weight', '数值换算', '乘=1000；容差=-0.1'),
  row('V01', 'weight', '数值换算', '乘=NaN'),
  row('V01', 'weight', '数值换算', '乘=Infinity'),
  row('V01', 'weight', '数值换算', '乘=1/1000'),
  row('V01', 'weight', '数值换算', '乘=1000；乘=1'),
  row('V01', 'weight', '数值换算', '乘=1000；误差=0.1'),
  row('V01', 'weight', '数值换算', '乘=0.001；最大=10'),
  row('V01', 'weight', '数值换算', '乘=1000', 'unit!=g'),
  row('V01', 'weight', '数值换算', '乘=1000', 'year>2020'),
  row('V01', 'weight', '数值换算', '乘=1000', 'unit=kg OR g'),
  row('V01', 'weight', '数值换算', '乘=1000', 'unit=kg；unit=g'),
  row('V01', 'weight', '数值换算', '乘=1000', 'unit="a、b"'),
  row('V01', 'weight→', '数值换算', '乘=1000'),
  row('V01', 'a→b→c', '数值换算', '乘=1000'),
  row('V01', 'weight、unit', '原值保留', '不变'),
  row('V01', 'name', '名称映射', 'a→b；a→c'),
  row('V01', 'name', '名称映射', '自动识别同义词'),
  row('V01', 'name', '名称映射', 'a→'),
  row('V01', 'name', '去空格', '删除全部空格'),
  row('V01', 'name', '原值保留', '自动规范格式'),
  row('V01', 'name', '自动推断', '合理'),
  row('V01', 'weight', '数值换算', '乘=1000', '全部', ''),
  row('V01', 'weight', '数值换算', '乘=1000', '全部', '待确认'),
  row('V01', 'weight', '数值换算', '例如乘=1000'),
  row('重复 编号', 'weight', '原值保留', '不变')
]) assert.equal(compile(plan([badRow])).valueRules.rules[0].kind, 'manual', badRow);
const manual = compile(plan([row('V01', 'weight', '人工判断', '暂不自动处理统计汇总，需研究者确定公式。')]));
assert.equal(manual.valueRules.rules[0].kind, 'manual');
assert.ok(manual.valueRules.rules[0].reason.includes('研究者'));
const narrative = compile(plan([row('V01', 'weight', '原值保留', '不变'), '另有要求：多步换算尚需确定。']));
assert.equal(narrative.valueRules.rules.length, 2); assert.equal(narrative.valueRules.rules[1].kind, 'manual');
const checkNarrative = compile(plan(valueNone, table + row('C01', 'weight', '非空', '非空') + '\n必须核对汇总与分项，不得混用。'));
assert.equal(checkNarrative.checks.rules.length, 2); assert.equal(checkNarrative.checks.rules[1].kind, 'manual');
const outside = compile('单位换算要求：体重统一为g。\n' + plan(valueNone));
assert.ok(outside.checks.rules.some(rule => rule.id.startsWith('clean-outside-') && rule.kind === 'manual'));
const legacy = compile(plan(valueNone) + '\n\n### 专业核验规则\n' + table + row('X01', 'Value', '非空', '非空'));
assert.ok(legacy.checks.rules.some(rule => rule.kind === 'manual'), 'An unrecognized extra rule section must not disappear');
const unknownText = '此处有完整的专有口径描述，还没有整理成表。';
assert.ok(compile(plan(valueNone) + '\n\n### 专业核验规则\n' + unknownText).checks.rules.some(rule => rule.sourceText.includes(unknownText)), 'Preserve unrecognized professional text');
for (const fence of ['```', '~~~']) {
  const fenced = compile(plan(fence + '\n' + table + row('V01', 'weight', '数值换算', '乘=1000') + '\n' + fence));
  assert.ok(fenced.valueRules.rules.every(rule => rule.kind === 'manual'), 'Code block examples cannot become automatic rules');
  const fencedChecks = compile(plan(valueNone, fence + '\n' + table + row('C01', 'Value', '非空', '非空') + '\n' + fence));
  assert.ok(fencedChecks.checks.rules.every(rule => rule.kind === 'manual'));
  const wholeExample = compile(fence + 'markdown\n' + plan([row('V01', 'weight', '原值保留', '不变')]) + '\n' + fence);
  assert.ok(wholeExample.checks.rules.every(rule => rule.kind === 'manual'));
  assert.ok(wholeExample.valueRules.rules.every(rule => rule.kind === 'manual'));
}
const candidate = compile(plan([row('V01', 'weight', '原值保留', '不变')]).replace('### 原值与结果核对', '### 原值与结果核对（候选）'));
assert.equal(candidate.valueRules.rules[0].kind, 'manual');
const duplicate = compile(plan([row('C01', 'a', '原值保留', '不变')], table + row('C01', 'a', '非空', '非空')));
assert.ok(duplicate.checks.rules.every(rule => rule.kind === 'manual'));
assert.ok(duplicate.valueRules.rules.every(rule => rule.kind === 'manual'), 'IDs must be unique across both sections');
const duplicateAlias = compile(plan([row('C01', 'a', '原值保留', '不变'), row('C01-duplicate-0', 'b', '原值保留', '不变')], table + row('C01', 'a', '非空', '非空')));
const finalIds = [...duplicateAlias.checks.rules, ...duplicateAlias.valueRules.rules].map(rule => rule.id);
assert.equal(new Set(finalIds).size, finalIds.length, 'Generated manual IDs cannot collide with source IDs');
const repeatedSection = compile(plan(valueNone) + '\n\n### 原值与结果核对\n' + valueNone);
assert.equal(repeatedSection.valueRules.rules[0].kind, 'manual');
const repeatedChecks = compile(plan(valueNone) + '\n\n### 清洗核验规则\n' + checkNone);
assert.ok(repeatedChecks.checks.rules.every(rule => rule.kind === 'manual'));
const quoted = compile(plan([row('V01', 'name', '名称映射', '" a "→""；__proto__→safe', 'raw=" 2,600 "')]));
assert.deepEqual(quoted.valueRules.rules[0].when, { raw: [' 2,600 '] }, 'Exact raw values are not numerically normalized');
assert.equal(quoted.valueRules.rules[0].mapping[' a '], '');
assert.equal(quoted.valueRules.rules[0].mapping.__proto__, 'safe');
assert.equal(Object.getPrototypeOf(quoted.valueRules.rules[0].mapping), Object.prototype);
assert.equal(compile(plan(valueNone, '本任务无额外专业规则。依据：-')).checks.rules[0].kind, 'manual');
const many = compile(plan(Array.from({ length: 201 }, (_, i) => row('V' + i, 'x', '原值保留', '不变'))));
assert.equal(many.valueRules.rules[0].kind, 'manual'); assert.equal(many.checks.rules[0].kind, 'manual');
assert.deepEqual(many.manualChecks, { schema: 1, state: 'none', rules: [] }, 'An automatic rule limit must not invent an unspecified manual standard');
const manyHuman = compile(withManual(Array.from({ length: 201 }, (_, i) => manualRow('M' + i, '来源口径', '对照来源', '口径一致'))));
assert.equal(manyHuman.manualChecks.state, 'needs_discussion'); assert.ok(manyHuman.manualChecks.rules[0].required && manyHuman.manualChecks.rules[0].reason);
const browser = { window: {} }; vm.createContext(browser);
vm.runInContext(fs.readFileSync(require.resolve('../js/download-professional-rules'), 'utf8'), browser);
vm.runInContext(fs.readFileSync(require.resolve('../js/clean-verification-rules'), 'utf8'), browser);
assert.equal(typeof browser.window.CleanVerificationRules.compile, 'function');
assert.equal(browser.window.CleanVerificationRules.compile(plan(valueNone)).valueRules.state, 'none');
assert.equal(browser.window.CleanVerificationRules.compile(withManual([manualRow('M01', '来源口径', '对照来源', '口径一致')])).manualChecks.state, 'specified');
const missingDependency = { window: {} }; vm.createContext(missingDependency);
vm.runInContext(fs.readFileSync(require.resolve('../js/clean-verification-rules'), 'utf8'), missingDependency);
assert.equal(missingDependency.window.CleanVerificationRules.compile(plan(valueNone)).checks.rules[0].kind, 'manual');
console.log('CLEAN_VERIFICATION_RULE_COMPILER_PASS (confirmed plan, exact decimals/raw conditions, explicit human standards/required checks, cross-section IDs, unknown/manual, browser/Node)');
