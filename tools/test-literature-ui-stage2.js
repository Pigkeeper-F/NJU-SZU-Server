#!/usr/bin/env node
/* ============================================================================
 * 文献挖掘 · 第二阶段 前端静态回归 —— node tools/test-literature-ui-stage2.js
 * ----------------------------------------------------------------------------
 * 归属：W1b（设计 §9.1 / §9.7）。只做静态检查（不启浏览器、不连本地服务）：
 *   受检文件：js/codex.js（文献模块 UI）与 css/workspace.css（样式定义）。
 *   覆盖：
 *     1. 语法可编译（vm.Script，不执行）
 *     2. stage 词汇全覆盖（含 awaiting_confirmation，设计 §2.5 / 契约 §21.1）
 *     3. awaiting_confirmation 确认表单 + advance 提交（契约 §21.2.2）
 *     4. jobs 历史任务找回（契约 §21.2.3）
 *     5. until 续跑窗口（契约 §21.2.1）与「继续/重试」入口（设计 §4.4）
 *     6. 按 job 快照 files 动态渲染的分组下载与折叠（V7 大 job 性能）
 *     7. 新类名均在 css/workspace.css 有定义
 *     8. 第一阶段关键文案/行为零回归（设计 §10）
 * 通过标准：输出 LITERATURE_UI_STAGE2_TESTS_PASS
 * ========================================================================== */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const codex = fs.readFileSync(path.join(ROOT, 'js', 'codex.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'workspace.css'), 'utf8');

// 1) 语法可编译（仅编译，不执行 IIFE）
new vm.Script(codex, { filename: 'js/codex.js' });

// 2) stage 词汇全覆盖
for (const stage of ['dedupe', 'fulltext', 'extraction', 'validation', 'export', 'awaiting_confirmation']) {
  assert.ok(codex.includes("'" + stage + "'"), '前端应认识第二阶段 stage: ' + stage);
}
for (const stage of ['queued', 'environment', 'browser', 'search', 'save', 'verification', 'completed', 'failed', 'cancelled', 'interrupted']) {
  assert.ok(codex.includes("'" + stage + "'"), '前端应保留第一阶段 stage: ' + stage);
}
assert.ok(codex.includes('等待确认字段'), 'awaiting_confirmation 应有中文阶段文案');
assert.ok(codex.includes('下一阶段：') && codex.includes('本次运行到：'), '阶段条应展示 resumeStage / until');

// 3) awaiting_confirmation 关口：确认表单 + advance 提交
assert.ok(codex.includes("job.stage === 'awaiting_confirmation'"), '应按 stage 区分字段确认关口与验证码关口');
assert.ok(codex.includes('确认并继续提取'), '确认按钮文案');
assert.ok(codex.includes('confirmations: { fields }'), '确认记录应以 confirmations.fields 提交');
assert.ok(codex.includes("'/api/literature/advance'"), '多阶段推进应走 advance');
assert.ok(codex.includes('function literatureConfirmFields'), '应从 fieldDefinitions/targetFields 预填确认表单');
assert.ok(codex.includes('fieldDefinitions') && codex.includes('targetFields'), '确认表单应优先使用 fieldDefinitions，退回 targetFields');
assert.ok(codex.includes('请先在“目标参数字段”中填写字段'), '无字段时应给出可执行提示而不是空表单');

// 4) jobs 历史任务找回
assert.ok(codex.includes("'/api/literature/jobs?limit=20'"), '历史任务应经 GET /jobs 读取');
assert.ok(codex.includes('function attachLiteratureJob'), '点击历史任务应能重新挂接');
assert.ok(codex.includes('literatureJobId'), '选中的任务应写入 localStorage 以便刷新后重挂');

// 5) until 续跑窗口 + 继续/重试入口
assert.ok(codex.includes('body.until = t.literatureUntil'), 'search/advance 应带 until');
assert.ok(codex.includes("t.literatureUntil && t.literatureUntil !== 'discover'"), 'until 缺省应保持 discover 语义');
assert.ok(codex.includes('仅首批检索') && codex.includes('完整流水线'), '应有运行边界选择项');
assert.ok(codex.includes('继续下一阶段'), 'completed 且 resumeStage 非空应可继续');
assert.ok(codex.includes('重试当前阶段') && codex.includes('继续中断的任务'), 'failed（含 interrupted）应可重试/继续');

// 6) 按 job.files 动态渲染的分组下载与折叠
for (const label of ['运行配置（冻结）', '候选清单 CSV（累计）', '去重结果 JSON', '全文获取状态', '校验结果 JSON', '待审核清单',
  '文献表 CSV', '文献表 Excel', '参数明细表 CSV', '参数明细表 Excel', '导出报告']) {
  assert.ok(codex.includes(label), '下载区应认识交付物: ' + label);
}
assert.ok(codex.includes('fulltext\\/files\\/') && codex.includes('extraction\\/inputs\\/'), '应识别全文与提取输入包路径');
assert.ok(codex.includes('展开其余 ') && codex.includes('literature-deliverable-more'), '长文件列表应折叠');
assert.ok(codex.includes('group.files.length > 8'), '分组下载应有折叠阈值（大 job 性能）');
assert.ok(codex.includes('literature-history-list'), '历史任务应折叠在 details 中渲染');

// 7) 新类名在 css/workspace.css 有定义
for (const cls of ['literature-stages', 'literature-stage', 'literature-stage-state', 'literature-stage-meta',
  'literature-confirm', 'literature-confirm-fields', 'literature-confirm-row', 'literature-confirm-actions',
  'literature-deliverables', 'literature-deliverable-group', 'literature-deliverable-title', 'literature-deliverable-list', 'literature-deliverable-more',
  'literature-history', 'literature-history-head', 'literature-history-list', 'literature-history-row', 'literature-history-id',
  'literature-history-status', 'literature-history-message']) {
  assert.ok(css.includes('.' + cls), 'css/workspace.css 应定义 .' + cls);
}
assert.ok(css.includes('.literature-stage.is-running') && css.includes('.literature-stage.is-done') && css.includes('.literature-history-row.is-current'),
  '阶段条与历史任务的状态样式应已定义');
assert.ok(css.includes('文献挖掘 · 第二阶段'), '样式应以独立分区追加');

// 8) 第一阶段关键文案/行为零回归（多源检索上线后，来源相关文案按新行为断言）
for (const text of ['从对话整理规则', '确认配置并检索', '手动填写', '验证后重新检索',
  '请先从对话整理运行配置并核对', '对话或已批准文档有更新，请重新整理规则后再检索',
  '首批候选检索已保存 ', '这不是已纳入文献，也未提取全文。可在文献检索区下载清单。']) {
  assert.ok(codex.includes(text), '第一阶段文案不得回归: ' + text);
}
for (const text of ['开放 API 源免验证', 'PubMed', 'OpenAlex', 'Europe PMC', 'Semantic Scholar', '人工']) {
  assert.ok(codex.includes(text), '多源检索能力应在配置面板可见: ' + text);
}
assert.ok(codex.includes('Google Scholar 需要人工验证。请在检索浏览器完成后点击“重新检索”。'), '验证码人工关口文案保持原句');
assert.ok(codex.includes("'/api/literature/prepare'") && codex.includes("'/api/literature/search'") && codex.includes("'/api/literature/cancel")
  && codex.includes("'/api/literature/download"), '既有路由与取消行为保持');
assert.ok(codex.includes('t.busy || !t.literatureConfig'), '未配置时启动按钮保持禁用');

// 9) 多源检索面板：状态必须进 docSigOf（否则增量快速路径会吞掉勾选/逐源命中）
for (const token of ['rs.sources', 'perSourceSig', 'sourceResultSig', '/api/literature/sources']) {
  assert.ok(chat.includes(token), '多源检索面板应包含: ' + token);
}
assert.ok(!chat.includes("sources: ['google-scholar'], limit: 10"), '调研面板不得把来源写死为 Scholar');

console.log('LITERATURE_UI_STAGE2_TESTS_PASS');
