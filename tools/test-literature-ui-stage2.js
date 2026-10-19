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
assert.ok(codex.includes('新增提取字段') && codex.includes('设置提取字段'), '已有任务可从空字段直接录入，不修改冻结检索配置');

// 4) jobs 历史任务找回
assert.ok(codex.includes("'/api/literature/jobs?limit=20'"), '历史任务应经 GET /jobs 读取');
assert.ok(codex.includes('function attachLiteratureJob'), '点击历史任务应能重新挂接');
assert.ok(codex.includes('literatureJobId'), '选中的任务应写入 localStorage 以便刷新后重挂');

// 5) until 续跑窗口 + 继续/重试入口
assert.ok(codex.includes("until: t.literatureUntil || 'discover'") && codex.includes('const body = { id: job.id, until }'), 'search/advance 应显式带 until，包括 discover');
assert.ok(codex.includes('仅检索候选') && codex.includes('完整流水线'), '应有运行边界选择项，检索阶段不混同测试模式');
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

// 8) 第一阶段关键文案/行为零回归
for (const text of ['从对话整理规则', '确认配置并检索', '手动填写', '打开登录/检索页面', '检查并继续',
  '检索来源（六个来源均可选择，按研究需要勾选）', '请先从对话整理运行配置并核对', '对话或已批准文档有更新，请重新整理规则后再检索',
  '候选检索已保存 ', '这不是已纳入文献，也未提取全文。可在文献检索区下载清单。']) {
  assert.ok(codex.includes(text), '第一阶段文案不得回归: ' + text);
}
assert.ok(codex.includes('job.attention?.source') && codex.includes('job.message || job.error'), '人工关口应使用实际来源与原因');
assert.ok(codex.includes("'/api/literature/prepare'") && codex.includes("'/api/literature/search'") && codex.includes("'/api/literature/cancel")
  && codex.includes("'/api/literature/download"), '既有路由与取消行为保持');
assert.ok(codex.includes('t.busy || !t.literatureConfig'), '未配置时启动按钮保持禁用');
assert.ok(codex.includes('PubMed 公开检索通常无需登录'), '公开接口与需人工登录来源应区分');
assert.ok(!codex.includes('（未接通）') && !codex.includes('请取消万方、Scopus、PubMed'), '六来源不再展示预留未接通文案');
for (const text of ['测试运行（每来源10条）', '正式检索（检索到末页）', '历史任务（按原数量）', '登录流程：', '数据库当前可访问末页']) {
  assert.ok(codex.includes(text), '模式与登录说明应可见：' + text);
}
assert.ok(!codex.includes('正式检索每来源候选上限') && !codex.includes('每来源候选上限（1–1000）'), '新界面不再提供正式数量输入');

// 9) 多来源前端行为：直接执行受检函数，模拟服务端；不启浏览器、不调用真实账户。
function functionSource(name) {
  const start = codex.indexOf('  async function ' + name + '(') >= 0 ? codex.indexOf('  async function ' + name + '(') : codex.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, '找不到受检函数 ' + name);
  const end = codex.indexOf('\n  }', start);
  return codex.slice(start, end + 4);
}
class Element {
  constructor(tag, text, className) { this.tag = tag; this.textContent = text || ''; this.className = className || ''; this.children = []; }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  setAttribute(key, value) { this[key] = value; }
}
function elements(parent) { return [parent, ...parent.children.flatMap(elements)]; }
const calls = [];
let responseJob = { id: 'existing-job' };
const current = { literatureBusy: false, busy: false };
const container = new Element('section');
const context = vm.createContext({
  task: () => current, root: { LiteratureUI: { isBusy: () => false } }, saved: {}, panel: container, account: { model: 'fixture-model' },
  node: (tag, text, className) => new Element(tag, text, className), render() {}, persist() {},
  request: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return responseJob; },
  watchLiterature: async (id, jobId) => calls.push({ watch: jobId }), applyLiteratureJob() {},
  checkLiteratureRuntime: async () => ({ protocolVersion: 1, restartRequired: false }),
  literatureSource: () => 'current-source', literatureStageLabel: stage => stage,
  literatureHistory: () => new Element('details'), literatureStageBar: () => null, literatureDeliverables: () => null,
  prepareLiterature() {}, manualLiterature() {}, startLiterature() {}, literatureConfirmForm: () => new Element('form'),
  CustomEvent: class {}, document: { dispatchEvent() {} }
});
const configCode = codex.slice(codex.indexOf('  const LITERATURE_CONFIG_KEYS'), codex.indexOf('  async function prepareLiterature'));
const labelsCode = codex.slice(codex.indexOf('  const LITERATURE_STAGE_ORDER'), codex.indexOf('  function literatureFileLabel'));
vm.runInContext(configCode + labelsCode + '\n' + ['startLiterature', 'continueLiterature', 'openLiteratureBrowser', 'literatureAttentionMessage', 'literatureStageBar', 'literaturePanel'].map(functionSource).join('\n')
  + '\nglobalThis.subject = { parseLiteratureConfig, newLiteratureSearchConfig, sameLiteratureConfig, startLiterature, continueLiterature, openLiteratureBrowser, literatureAttentionMessage, literatureStageLabel, literatureStageBar, literaturePanel };', context);
const subject = context.subject;

async function multiSourceTests() {
  assert.equal(subject.literatureStageLabel('discover'), '检索候选', 'Discover stage should use its Chinese label');
  const pausedStageJob = { status: 'needs_attention', resumeStage: 'discover', until: 'discover', stages: { discover: 'running' } };
  const pausedStageBytes = JSON.stringify(pausedStageJob);
  const pausedBar = subject.literatureStageBar(pausedStageJob);
  assert.equal(pausedBar.children[0].className, 'literature-stage is-pending');
  assert.equal(pausedBar.children[0].children[0].textContent, '检索候选');
  assert.equal(pausedBar.children[0].children[1].textContent, '待人工处理', 'Human wait must not be shown as running');
  assert.equal(JSON.stringify(pausedStageJob), pausedStageBytes, 'Stage rendering must not alter the saved task');
  assert.equal(subject.literatureStageBar({ ...pausedStageJob, status: 'running' }).children[0].children[1].textContent, '进行中');
  for (const ending of ['。', '.', '。...']) {
    const punctuationMessage = subject.literatureAttentionMessage({ attention: { source: 'cnki' }, message: '请登录' + ending });
    assert.ok(punctuationMessage.includes('请登录。请在平台专用'));
    assert.ok(!punctuationMessage.includes('。。') && !punctuationMessage.includes('.。'));
    const genericMessage = subject.literatureAttentionMessage({ message: '网络暂停' + ending });
    assert.ok(genericMessage.startsWith('网络暂停。处理问题'));
  }
  const config = subject.parseLiteratureConfig(JSON.stringify({ topic: '温度与肉鸡', query: 'broiler heat stress',
    sources: ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'],
    sourceQueries: { cnki: '肉鸡 热应激', wanfang: '肉鸡 高温', 'web-of-science': 'broiler AND heat',
      scopus: '(broiler OR broilers) AND "heat stress"', pubmed: 'broiler[Title/Abstract] AND "heat stress"[Title/Abstract]' } }));
  assert.equal(config.sourceQueries.cnki, '肉鸡 热应激', 'AI整理结果不能丢来源检索式');
  assert.equal(config.searchMode, 'test', '新整理配置默认测试');
  assert.equal(config.stopMode, 'count', '测试模式按数量停止');
  assert.equal(config.perSourceLimit, 10, '测试每来源固定10条');
  const formal = subject.parseLiteratureConfig(JSON.stringify({ ...config, searchMode: 'formal', perSourceLimit: 120, limit: 2, batch: { size: 2, maxBatches: 3 } }));
  assert.equal(formal.limit, 10, '正式数量独立于接口页大小');
  assert.equal(formal.batch.size, 10, '新模式接口页大小为10');
  assert.equal(formal.stopMode, 'end', '新整理的正式检索直接到可访问末页');
  assert.equal(formal.perSourceLimit, null, '正式检索不保留AI建议的数量停止条件');
  for (const value of [undefined, 120, 1001, null]) {
    const end = subject.newLiteratureSearchConfig({ ...config, searchMode: 'formal', perSourceLimit: value });
    assert.equal(end.perSourceLimit, null, '新正式配置不使用数量上限'); assert.equal(end.stopMode, 'end');
  }
  assert.equal(subject.newLiteratureSearchConfig({ ...config, searchMode: 'test', perSourceLimit: 999 }).perSourceLimit, 10, '测试模式不能扩大数量');
  assert.equal(subject.sameLiteratureConfig(config, { ...config, searchMode: 'formal', perSourceLimit: 10 }), false, '模式改变需新任务');
  const legacyFormal = { ...formal, perSourceLimit: 120, limits: { discover: 1800, fulltext: 3600 } }; delete legacyFormal.stopMode;
  const originalFormalLimits = JSON.stringify(legacyFormal.limits);
  const convertedFormal = subject.newLiteratureSearchConfig(legacyFormal);
  assert.equal(convertedFormal.limits.discover, undefined, '旧数量正式任务转新末页任务时重算检索预算');
  assert.equal(convertedFormal.limits.fulltext, 3600, '转换仍保留其他阶段预算');
  assert.equal(JSON.stringify(legacyFormal.limits), originalFormalLimits, '转换不能修改旧任务的冻结预算');
  assert.notEqual(convertedFormal.limits, legacyFormal.limits, '转换使用独立预算副本');
  const explicitEnd = { ...formal, limits: { discover: 4321, fulltext: 3600 } };
  assert.equal(subject.newLiteratureSearchConfig(explicitEnd).limits.discover, 4321, '已有末页配置保留显式运行预算');
  assert.equal(subject.parseLiteratureConfig(JSON.stringify(explicitEnd)).limits.discover, 4321, '整理已有末页配置也保留显式运行预算');
  assert.equal(subject.sameLiteratureConfig(legacyFormal, { ...legacyFormal, stopMode: 'count' }), true, '旧正式缺省停止方式仍为count');
  assert.equal(subject.sameLiteratureConfig(legacyFormal, { ...legacyFormal, perSourceLimit: 121 }), false, '旧正式目标数量改变需新任务');
  assert.equal(subject.sameLiteratureConfig(legacyFormal, formal), false, '旧按数量任务与新末页任务不混用');
  assert.equal(subject.sameLiteratureConfig({ ...config, stopMode: undefined }, config), true, '旧测试缺省停止方式仍按数量');
  assert.equal(subject.sameLiteratureConfig(config, { ...config, sourceQueries: Object.fromEntries(Object.entries(config.sourceQueries).reverse()) }), true, '映射顺序不改变冻结配置');
  assert.equal(subject.sameLiteratureConfig(config, { ...config, sourceQueries: { cnki: '肉鸡 高温' } }), false, '来源检索式变化须新建任务');
  assert.equal(subject.sameLiteratureConfig({ ...config, sourceQueries: undefined }, { ...config, sourceQueries: {} }), true, '旧任务缺省来源映射兼容');
  assert.throws(() => subject.parseLiteratureConfig(JSON.stringify({ ...config, sourceQueries: { cnki: [] } })), /格式无效/);
  context.saved['module-1'] = { literatureSource: 'current-source' };
  current.literatureConfig = config; current.literatureUntil = 'discover';
  responseJob = { id: 'existing-job', config: { ...config, extraction: { model: 'fixture-model', maxCharsPerPaper: 120000 } } };
  await subject.startLiterature({ id: 'module-1' });
  assert.equal(current.literatureConfig.extraction.maxCharsPerPaper, 120000, '新任务应保存服务端规范化后的冻结配置，避免默认字段误报配置已改');
  assert.notEqual(current.literatureConfig, responseJob.config, '编辑草稿不得改变已冻结任务对象');
  assert.equal(calls[0].body.until, 'discover', '首次只检索也显式发送运行边界');
  calls.length = 0; responseJob = { id: 'existing-job' };
  current.literatureConfig = config;
  current.literatureUntil = 'discover';
  current.literatureJob = { id: 'existing-job', config, status: 'needs_attention', stage: 'login', resumeStage: 'discover', until: 'discover',
    attention: { source: 'cnki', reason: 'login' }, message: '请完成知网机构登录' };
  await subject.continueLiterature({ id: 'module-1' });
  assert.deepEqual(calls[0], { url: '/api/literature/advance', body: { id: 'existing-job', until: 'discover' } }, '登录恢复必须同一job，且仅首批不隐式export');
  assert.ok(!calls.some(call => call.url === '/api/literature/search'), '恢复不得另建检索');
  assert.ok(subject.literatureAttentionMessage(current.literatureJob).includes('中国知网：请完成知网机构登录'), '提示须呈现真实来源与消息');
  calls.length = 0;
  await subject.openLiteratureBrowser({ id: 'module-1' });
  assert.deepEqual(calls[0], { url: '/api/literature/browser', body: { id: 'existing-job' } }, '打开页面只传任务id，不能传URL或凭据');
  calls.length = 0;
  current.literatureConfig = { ...config, sourceQueries: { cnki: '新的检索式' } };
  await subject.continueLiterature({ id: 'module-1' });
  assert.equal(calls.length, 0); assert.match(current.literatureError, /不能混入旧任务/);
  current.literatureConfig = config;
  current.literatureJob = { ...current.literatureJob, status: 'completed', resumeStage: 'dedupe' };
  await subject.continueLiterature({ id: 'module-1' });
  assert.equal(calls.length, 0, '完成检索后仍选择discover应先提示调整阶段'); assert.match(current.literatureError, /选择/);
  current.literatureUntil = 'fulltext';
  await subject.continueLiterature({ id: 'module-1' });
  assert.equal(calls[0].body.until, 'fulltext', '继续按用户新选边界推进');

  container.children.length = 0;
  current.literatureJob = { ...current.literatureJob, status: 'needs_attention', stage: 'access_required', resumeStage: 'discover',
    attention: { source: 'web-of-science', reason: 'access_required' }, message: '机构访问权限不足' };
  subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  const nodes = elements(container);
  const sourceLabels = ['Google Scholar', '中国知网', '万方', 'Web of Science 核心合集', 'Scopus', 'PubMed'];
  const checks = nodes.filter(item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(checks.length, 6, '页面提供全部六来源');
  assert.ok(checks.every(item => item.checked && !item.disabled), '六来源均可选择，不要求登录后才能勾选');
  for (const label of sourceLabels) {
    assert.ok(nodes.some(item => item.tag === 'label' && item.textContent === label && item.children[0]?.type === 'checkbox'), '来源标签完整：' + label);
    const queryField = nodes.find(item => item.tag === 'label' && item.textContent === label + ' 检索式（留空沿用默认）')?.children[0];
    assert.ok(queryField?.placeholder, '每个来源提供独立检索式示例：' + label);
  }
  const queryExample = label => nodes.find(item => item.tag === 'label' && item.textContent === label + ' 检索式（留空沿用默认）').children[0].placeholder;
  assert.match(queryExample('万方'), /肉鸡 高温/);
  assert.match(queryExample('Scopus'), /Documents：Title Abstract Keywords/);
  assert.match(queryExample('PubMed'), /\[Title\/Abstract\]/);
  const wanfangCheck = nodes.find(item => item.tag === 'label' && item.textContent === '万方').children[0];
  wanfangCheck.checked = false; wanfangCheck.onchange();
  assert.ok(!current.literatureConfig.sources.includes('wanfang'), '各来源可独立取消，非必须全选');
  wanfangCheck.checked = true; wanfangCheck.onchange();
  assert.ok(current.literatureConfig.sources.includes('wanfang'));
  assert.ok(nodes.some(item => item.tag === 'button' && item.textContent === '打开登录/检索页面'));
  assert.ok(nodes.some(item => item.tag === 'button' && item.textContent === '检查并继续'));
  assert.ok(nodes.some(item => item.textContent.includes('Web of Science 核心合集：机构访问权限不足')));
  const waitIndex = nodes.findIndex(item => item.tag === 'button' && item.textContent === '检查并继续');
  const settingsIndex = nodes.findIndex(item => item.className === 'literature-config');
  assert.ok(waitIndex >= 0 && waitIndex < settingsIndex, '人工关口按钮须置于设置前，避免被长设置表掩埋');
  assert.equal(nodes[settingsIndex].open, false, '等待处理时设置默认收起');
  const cnkiField = nodes.find(item => item.tag === 'label' && item.textContent === '中国知网 检索式（留空沿用默认）').children[0];
  cnkiField.value = '肉鸡 高温 日增重'; cnkiField.oninput();
  assert.equal(current.literatureConfig.sourceQueries.cnki, '肉鸡 高温 日增重');
  cnkiField.value = ''; cnkiField.oninput();
  assert.equal(current.literatureConfig.sourceQueries.cnki, undefined, '空来源检索式回到默认query');

  // 旧任务按原冻结数量恢复；显示设置时不补模式，也不改变原来的小批大小。
  const legacy = { ...config, limit: 2, batch: { size: 2, maxBatches: 3 }, limits: { discover: 180, fulltext: 3600 } };
  delete legacy.searchMode; delete legacy.perSourceLimit; delete legacy.stopMode;
  const legacyBefore = JSON.stringify(legacy);
  current.literatureConfig = JSON.parse(legacyBefore); current.literatureUntil = 'discover';
  current.literatureJob = { id: 'legacy-job', config: legacy, status: 'needs_attention', stage: 'login', resumeStage: 'discover', until: 'discover',
    attention: { source: 'cnki', reason: 'login' }, message: '请完成登录' };
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  let modeNodes = elements(container);
  let modeSelect = modeNodes.find(item => item.tag === 'select' && item['aria-label'] === '文献检索运行模式');
  assert.equal(modeSelect.value, '', '历史任务显示原数量选项');
  assert.ok(modeNodes.some(item => item.textContent.includes('每来源每批最多 2 条')), '旧limit2不能显示成测试10');
  assert.equal(JSON.stringify(current.literatureConfig), legacyBefore, '渲染不得补写旧模式或改变检查点配置');
  calls.length = 0;
  await subject.continueLiterature({ id: 'module-1' });
  assert.deepEqual(calls[0], { url: '/api/literature/advance', body: { id: 'legacy-job', until: 'discover' } }, '旧任务保留原id续跑');
  assert.equal(JSON.stringify(legacy), legacyBefore, '恢复不能改变旧任务冻结配置');
  const legacyNew = subject.newLiteratureSearchConfig(legacy);
  assert.equal(legacyNew.searchMode, 'test'); assert.equal(legacyNew.perSourceLimit, 10);
  assert.equal(legacyNew.limit, 10); assert.equal(legacyNew.batch.size, 10);
  assert.equal(JSON.stringify(legacy), legacyBefore, '新检索模式转换只修改副本');
  assert.equal(subject.sameLiteratureConfig(legacy, legacyNew), false, '旧limit2不能误判成测试10');

  // 正式固定到末页；模式变更后重算自动检索预算，并禁止旧任务继续。
  modeSelect.value = 'formal'; modeSelect.onchange();
  assert.equal(current.literatureConfig.searchMode, 'formal'); assert.equal(current.literatureConfig.perSourceLimit, null);
  assert.equal(current.literatureConfig.stopMode, 'end');
  assert.equal(current.literatureConfig.limits.discover, undefined, '模式变更后由服务端重算检索预算');
  assert.equal(current.literatureConfig.limits.fulltext, 3600, '其他阶段预算保留');
  assert.equal(JSON.stringify(legacy), legacyBefore, '编辑草稿不能改变历史job');
  calls.length = 0; await subject.continueLiterature({ id: 'module-1' });
  assert.equal(calls.length, 0, '模式变更必须新检索'); assert.match(current.literatureError, /不能混入旧任务/);
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  modeNodes = elements(container);
  assert.ok(!modeNodes.some(item => item['aria-label'] === '正式检索每来源候选上限'), '正式没有数量停止输入');
  assert.ok(modeNodes.some(item => item.textContent.includes('数据库当前可访问末页')), '正式说明可访问范围，不声称获取全部主题文献');
  current.literatureConfig.limits.discover = 180;
  const formalCnki = modeNodes.find(item => item.tag === 'label' && item.textContent === '中国知网').children[0];
  formalCnki.checked = false; formalCnki.onchange();
  assert.equal(current.literatureConfig.limits.discover, undefined, '来源变更后重算自动预算');
  calls.length = 0; responseJob = { id: 'new-formal', config: JSON.parse(JSON.stringify(current.literatureConfig)) };
  await subject.startLiterature({ id: 'module-1' });
  assert.equal(calls[0].body.config.searchMode, 'formal'); assert.equal(calls[0].body.config.perSourceLimit, null);
  assert.equal(calls[0].body.config.stopMode, 'end');
  assert.equal(calls[0].body.config.limit, 10, '正式请求使用独立数量字段，页大小仍为10');

  // 历史按数量正式任务仍可恢复；新启动副本转换末页，不改旧配置。
  const legacyFormalBefore = JSON.stringify(legacyFormal);
  current.literatureConfig = JSON.parse(legacyFormalBefore); current.literatureUntil = 'discover';
  current.literatureJob = { id: 'legacy-formal', config: legacyFormal, status: 'needs_attention', stage: 'login', resumeStage: 'discover', until: 'discover',
    attention: { source: 'cnki', reason: 'login' }, message: '请完成登录' };
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  modeNodes = elements(container);
  assert.ok(modeNodes.some(item => item.textContent.includes('历史正式配置保持原数量：每来源候选上限 120 条')));
  assert.ok(!modeNodes.some(item => item['aria-label'] === '正式检索每来源候选上限'));
  assert.equal(JSON.stringify(current.literatureConfig), legacyFormalBefore, '渲染不能把旧正式任务改成末页');
  calls.length = 0; await subject.continueLiterature({ id: 'module-1' });
  assert.deepEqual(calls[0], { url: '/api/literature/advance', body: { id: 'legacy-formal', until: 'discover' } }, '旧正式任务继续用原id与配置');
  calls.length = 0; responseJob = { id: 'new-end' };
  await subject.startLiterature({ id: 'module-1' });
  assert.equal(calls[0].body.config.stopMode, 'end'); assert.equal(calls[0].body.config.perSourceLimit, null);
  assert.equal(calls[0].body.config.limits.discover, undefined); assert.equal(calls[0].body.config.limits.fulltext, 3600);
  assert.equal(JSON.stringify(legacyFormal), legacyFormalBefore, '新正式请求转换不能修改旧冻结配置');

  // 非数据库登录的通用暂停可检查续跑，不显示无效登录按钮。
  current.literatureJob = { id: 'network-pause', config: JSON.parse(JSON.stringify(current.literatureConfig)), status: 'needs_attention', stage: 'interrupted',
    resumeStage: 'discover', until: 'discover', message: '检索单次运行超时，已保存7页，请检查网络后继续' };
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  modeNodes = elements(container);
  assert.ok(modeNodes.some(item => item.tag === 'button' && item.textContent === '检查并继续' && !item.disabled));
  assert.ok(!modeNodes.some(item => item.tag === 'button' && item.textContent === '打开登录/检索页面'));
  const pausedMessage = subject.literatureAttentionMessage(current.literatureJob);
  assert.match(pausedMessage, /已保存7页/); assert.ok(!pausedMessage.includes('请打开登录'));
  calls.length = 0; await subject.continueLiterature({ id: 'module-1' });
  assert.deepEqual(calls[0], { url: '/api/literature/advance', body: { id: 'network-pause', until: 'discover' } });

  // 普通页面持续说明登录位置，只有真正等待人工时才提供续跑按钮。
  current.literatureJob = null;
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  modeNodes = elements(container);
  assert.ok(modeNodes.some(item => item.textContent.includes('登录流程：')));
  assert.ok(!modeNodes.some(item => item.tag === 'button' && ['打开登录/检索页面', '检查并继续'].includes(item.textContent)), '没有等待任务时不提供假登录或续跑按钮');
  modeSelect = modeNodes.find(item => item.tag === 'select' && item['aria-label'] === '文献检索运行模式');
  modeSelect.value = 'test'; modeSelect.onchange();
  assert.equal(current.literatureConfig.perSourceLimit, 10, '从正式切回测试恢复固定10条');
  container.children.length = 0; subject.literaturePanel({ id: 'module-1', messages: [] }, current, container);
  assert.ok(!elements(container).some(item => item['aria-label'] === '正式检索每来源候选上限'), '测试模式不提供可扩大数量的输入');
  console.log('LITERATURE_UI_STAGE2_TESTS_PASS');
}
multiSourceTests().catch(error => { console.error(error); process.exitCode = 1; });
