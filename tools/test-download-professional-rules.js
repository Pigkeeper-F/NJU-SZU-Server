'use strict';
// Compilation is offline and has no approval, filesystem or execution effects.
const assert = require('node:assert/strict');
const { compile } = require('../js/download-professional-rules');
const header = '### 专业核验规则\n\n| 编号 | 检查字段 | 检查方法 | 通过条件 | 适用条件 | 依据 |\n|---|---|---|---|---|---|\n';
const plan = rows => '# 本地测试方案\n\n' + header + rows.join('\n') + '\n\n### 后续处理\n保留原件。';
const good = compile(plan([
  '| P01 | Year、Unit、Value | 必需字段 | 全部存在 | 全部 | 模型输入字段约定 |',
  '| P02 | Value | 非空 | 不得为空 | 全部 | 模型不接受空输入 |',
  '| P03 | Unit | 允许值 | t、kg | Element Code=5610、5910；Item Code=15 | 本合成测试的单位约定 |',
  '| P04 | Value | 数值范围 | 最小=0；最大=1.00000000000000000001 | 全部 | 合成数据精度边界 |',
  '| P05 | Year、Item Code | 唯一键 | 组合不重复 | 全部 | 本合成测试的一条记录定义 |',
  '| P06 | 记录数 | 记录数 | 最小=1 | 全部 | 本合成测试至少一行 |'
]));
assert.equal(good.state, 'compiled'); assert.equal(good.rules.length, 6);
assert.deepEqual(good.rules[2].when, { 'Element Code': ['5610', '5910'], 'Item Code': ['15'] });
assert.equal(good.rules[3].max, '1.00000000000000000001', 'Do not round confirmed decimal bounds');
assert.equal(compile('旧方案只有通用检查').rules[0].kind, 'manual');
assert.equal(compile(header).rules[0].kind, 'manual');
assert.equal(compile('### 专业核验规则\n本任务无额外专业规则。依据：此测试仅确认文件传输，业务检查留在独立阶段。').state, 'none');
for (const row of [
  '| P01 | Value | 数值范围 | 最大=NaN | 全部 | 确认依据 |',
  '| P01 | Value | 数值范围 | 最小=2；最大=1 | 全部 | 确认依据 |',
  '| P01 | Value | 数值范围 | 大概合理 | 全部 | 确认依据 |',
  '| P01 | Value | 非空 | 不得为空 | 全部 | 待确认 |',
  '| P01 | Value | 数值范围 | 最小=0 | Year>2020 | 确认依据 |',
  '| P01 | Value | 自动推断单位 | 合理 | 全部 | 确认依据 |',
  '| P01 | 记录数 | 记录数 | 最小=0.5 | 全部 | 确认依据 |',
  '| P01 | Value、Unit | 非空 | 不得为空 | 全部 | 确认依据 |'
]) assert.equal(compile(plan([row])).rules[0].kind, 'manual', row);
const outside = compile(plan(['| P01 | Value | 非空 | 不得为空 | 全部 | 确认依据 |', '另有一项专业要求：不得混用汇总和分项。']));
assert.equal(outside.rules.length, 2); assert.equal(outside.rules[1].kind, 'manual', 'Do not silently drop narrative requirements');
assert.ok(compile(plan(['| P01 | Value | 非空 | 不得为空 | 全部 | 确认依据 |', '| P01 | Unit | 非空 | 不得为空 | 全部 | 确认依据 |'])).rules.every(rule => rule.kind === 'manual'));
assert.equal(compile(header + '```\n| P01 | Value | 非空 | 不得为空 | 全部 | 确认依据 |\n```').state, 'needs_discussion', 'Examples in code blocks cannot become automatic rules');
assert.equal(compile('```markdown\n' + plan(['| P01 | Value | 非空 | 不得为空 | 全部 | 确认依据 |']) + '\n```').state, 'unspecified', 'A whole example plan inside a fence is not an executable rule section');
assert.equal(compile(plan(['| P01 | Value | 非空 | 不得为空 | 全部 | 确认依据 |']).replace('### 专业核验规则', '### 专业核验规则（候选）')).rules[0].kind, 'manual');
console.log('DOWNLOAD_PROFESSIONAL_RULE_COMPILER_PASS (confirmed table, scope, decimal preservation, narrative/unknown/ambiguous/manual)');
