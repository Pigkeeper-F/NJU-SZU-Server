'use strict';
// Plan text only. No model, user dataset, clean run, or runtime writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prepare, resolve } = require('../js/clean-execution-plan');
const { compile } = require('../js/clean-verification-rules');
// Normalize checkout line endings so the CRLF-browser-approval case below
// converts LF deliberately instead of doubling existing \r\n on Windows.
const source = fs.readFileSync(path.join(__dirname, 'fixtures/fbsh80-a-plan.md'), 'utf8').replace(/\r\n?/g, '\n');
const result = prepare(source);
assert.ok(result);
assert.equal(result.text, source, 'The original source must remain byte-for-byte text, not rewritten');
assert.equal(result.adapter, 'fbsh80-a-preserve-v1');
assert.equal(result.sourceSha256, null, 'Only the backend freezes an actual SHA');
assert.deepEqual(result.inputReferenceNames, ['3f7c827b-FBSH_1992_Afghanistan_练习样本.csv']);
assert.deepEqual(result.standardReferenceNames, ['44ae677d-数据来源与范围.txt']);
const compiled = compile(result.executionText);
assert.equal(compiled.checks.state, 'compiled');
assert.equal(compiled.checks.rules.length, 10);
assert.ok(compiled.checks.rules.every(rule => rule.kind !== 'manual'));
assert.equal(compiled.valueRules.state, 'none');
assert.deepEqual(compiled.valueRules.rules, [], 'Do not add conversion, deletion, or inferred thresholds');
assert.equal(compiled.manualChecks.state, 'specified');
assert.deepEqual(compiled.manualChecks.rules.map(rule => rule.id), ['H1', 'H2', 'H3']);
assert.ok(compiled.manualChecks.rules.every(rule => rule.required && !rule.reason && !rule.resolution && !rule.status), 'A standard is not an approval');
const humanRows = source.split(/\r?\n/).filter(line => /^\| H[123] \|/.test(line));
assert.deepEqual(compiled.manualChecks.rules.map(rule => rule.sourceText), humanRows, 'Keep all human criteria and cited evidence unchanged');
assert.equal(compiled.checks.rules.find(rule => rule.id === 'C1_fields').columns.length, 13);
assert.deepEqual(compiled.checks.rules.find(rule => rule.id === 'C4_key').columns, ['Area Code (M49)', 'Item Code', 'Element Code', 'Year']);
assert.ok(result.limitations[0].includes('Value十进制解析'));
assert.ok(result.limitations[0].includes('独立检查证据'), 'Unsupported checks must not be called compiled');
assert.equal(result.binding, null);
const binding = {
  sourceName: '3f7c827b-FBSH_1992_Afghanistan_练习样本.csv',
  inputName: '3f7c827b-FBSH_1992_Afghanistan_练习样本.csv',
  sha256: '0247cc2079a04125980ccf9510a4e3d56960734633012ef6181dddd65965f2c0'
};
const resolved = resolve(source, binding);
assert.ok(resolved);
assert.ok(resolved.text.startsWith('## 已确认A规则（执行衔接更新）'));
assert.ok(!resolved.text.includes('待确认'), 'Resolved technical tail must not leave pending questions');
assert.ok(resolved.text.includes('解析失败时保存错误位置与证据并停止，不猜测修复'));
assert.ok(resolved.text.includes('保留全部记录，不删除、不合并'));
assert.ok(resolved.text.includes('核验不予通过'));
assert.ok(resolved.text.includes('人工结论仍由研究者填写'));
assert.equal(source, fs.readFileSync(path.join(__dirname, 'fixtures/fbsh80-a-plan.md'), 'utf8').replace(/\r\n?/g, '\n'), 'Resolving never writes or changes the original rule');
assert.deepEqual(resolved.binding, binding);
assert.equal(resolved.adapter, result.adapter);
assert.deepEqual(resolved.inputReferenceNames, result.inputReferenceNames);
assert.deepEqual(resolved.standardReferenceNames, result.standardReferenceNames);
assert.equal(prepare(resolved.text).text, resolved.text);
assert.equal(resolve(resolved.text, binding).text, resolved.text, 'Same binding is idempotent');
const resolvedCompiled = compile(resolved.executionText);
assert.deepEqual(resolvedCompiled.checks.rules, compiled.checks.rules, 'Resolution does not change scientific check rules');
assert.deepEqual(resolvedCompiled.valueRules, compiled.valueRules);
assert.deepEqual(resolvedCompiled.manualChecks.rules.map(rule => rule.sourceText), humanRows, 'Human standards and citations remain exact original text');
assert.ok(resolvedCompiled.manualChecks.rules.every(rule => !rule.status && !rule.resolution), 'Do not approve human checks');
const cRows = text => text.split(/\r?\n/).filter(line => /^\| C[1-5] \|/.test(line));
assert.deepEqual(cRows(resolved.text), cRows(source), 'C1–C5 original table remains unchanged');
assert.ok(prepare(resolved.text.replace(/\n/g, '\r\n')));
const aliasBinding = {
  sourceName: '1918facb-FBSH_1992_Afghanistan_练习样本.csv',
  inputName: '3490741e-FBSH_1992_Afghanistan_练习样本.csv',
  sha256: binding.sha256
};
const aliased = resolve(source, aliasBinding);
assert.ok(aliased, 'Same basename with different upload aliases is supported');
assert.deepEqual(aliased.binding, aliasBinding);
assert.deepEqual(aliased.inputReferenceNames, [aliasBinding.inputName]);
assert.equal(prepare(aliased.text).text, aliased.text);
assert.equal(resolve(aliased.text, aliasBinding).text, aliased.text);
assert.ok(!aliased.text.includes(binding.inputName), 'All obsolete CSV citations are re-pointed to the bound input');
assert.deepEqual(cRows(aliased.text), cRows(source), 'CSV alias relocation does not change the C table');
const aliasedCompiled = compile(aliased.executionText);
assert.deepEqual(aliasedCompiled.manualChecks.rules.map(rule => rule.sourceText), humanRows.map(line => line.replaceAll(binding.inputName, aliasBinding.inputName)), 'H standards change only the evidence filename alias');
assert.deepEqual(aliasedCompiled.checks.rules, compiled.checks.rules);
assert.deepEqual(aliasedCompiled.valueRules, compiled.valueRules);
assert.equal(resolve(aliased.text, { ...aliasBinding, sha256: '0'.repeat(64) }), null);
assert.equal(prepare(aliased.text.replace('| H2 | 不同条目独立保留', '| H2 | 所有条目合并')), null);
assert.equal(prepare(aliased.text.replace('附件：' + aliasBinding.inputName, '附件：' + binding.inputName)), null, 'Every H citation must agree with the bound input alias');
for (const badBinding of [
  null, {},
  { ...binding, sourceName: 'other.csv' },
  { ...binding, inputName: 'other.csv' },
  { ...aliasBinding, inputName: '../' + aliasBinding.inputName },
  { ...aliasBinding, sourceName: 'reference/' + aliasBinding.sourceName },
  { ...aliasBinding, sourceName: '1918facb-other.csv' },
  { ...aliasBinding, inputName: '3490741e-FBSH_1993_Afghanistan_练习样本.csv' },
  { ...binding, sha256: '' },
  { ...binding, sha256: 'a'.repeat(63) },
  { ...binding, sha256: 'g'.repeat(64) },
  { ...binding, sha256: 'A'.repeat(64) },
  { ...binding, sha256: binding.sha256 + '\n' }
]) assert.equal(resolve(source, badBinding), null);
assert.equal(resolve(resolved.text, { ...binding, sha256: '0'.repeat(64) }), null, 'Never silently rebind an existing rule version');
for (const badText of [
  resolved.text + '\n另外将Value乘以1000。',
  resolved.text.replace('不翻译、不换算', '翻译并换算'),
  resolved.text.replace(binding.sha256, 'g'.repeat(64)),
  resolved.text.replace(binding.sha256, binding.sha256.slice(0, 63)),
  resolved.text.replace('执行input副本 `' + binding.inputName, '执行input副本 `other.csv'),
  resolved.text.replace('原件保留，执行前核对副本校验值。', '原件可删除。'),
  resolved.text.replace('| H2 |', '| H8 |'),
  resolved.text.replace('H1—H3人工结论仍由研究者填写', 'H1—H3人工结论已通过')
]) assert.equal(prepare(badText), null, 'Reject modified resolved policies and malformed binding');
assert.ok(prepare('\n' + source.trim().replace(/\n/g, '\r\n') + '\r\n'));
assert.ok(prepare(source.replace(/3f7c827b-/g, '').replace(/44ae677d-/g, '')));
assert.ok(prepare(source.replace(/3f7c827b-/g, '1234abcd-').replace(/44ae677d-/g, 'abcd1234-')));
for (const altered of [
  '', null, undefined, 123, result.executionText,
  source + '\n另外将全部Value乘以1000。',
  source.replace('不翻译、不换算', '不翻译、全部换算'),
  source.replace('80条记录', '81条记录'),
  source.replace('仅保留原值，不进行改值', '仅保留原值并执行数值换算'),
  source.replace('| H2 |', '| H8 |'),
  source.replace('| 是 | 附件：44ae677d-', '| 否 | 附件：44ae677d-'),
  source.replace('3f7c827b-FBSH_', 'aaaaaaaa-FBSH_') // Inconsistent references are unsafe.
]) assert.equal(prepare(altered), null);
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/clean-execution-plan.js'), 'utf8'), browser);
assert.equal(typeof browser.window.CleanExecutionPlan.prepare, 'function');
assert.equal(typeof browser.window.CleanExecutionPlan.resolve, 'function');
assert.equal(browser.window.CleanExecutionPlan.prepare(source).executionText, result.executionText);
assert.equal(browser.window.CleanExecutionPlan.resolve(source, binding).text, resolved.text);
process.stdout.write('clean-execution-plan: PASS (strict original/resolved A plans, immutable data policy and human standards, exact file/hash binding)\n');
