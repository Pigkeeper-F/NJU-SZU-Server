'use strict';
/**
 * 选题冷启动（环节①入口）+ 科学问题凝练（环节②）+ 人工初筛过滤的回归测试。
 * 全部用 mock 模型，不联网。
 *
 * 用法：node tools/test-research-question.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const rq = require('./research-question');
const research = require('./literature-research');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.log('  ✗ ' + label); }
}

const GAPS = [{
  gap: '长期施肥在北方旱地土壤的证据不足',
  basis: [{ id: 'GSC-001', what: 'meta 分析只覆盖水稻土' }],
  direction: '在北方旱地开展长期定位试验'
}];

const NOTES = [{
  id: 'GSC-001', title: 'Long-term fertilization and SOC', authors: 'A Author', year: 2015,
  evidence: '仅题录', question: '长期施肥对 SOC 的影响', conclusion: '长期施肥提高 SOC', limitation: '未覆盖北方土壤'
}];

(async () => {
  console.log('选题冷启动 + 问题凝练 回归（mock 模型）');

  console.log('\nS1 选题拆解：模糊想法 → 维度 + 候选检索式');
  const planReply = JSON.stringify({
    dimensions: [{ name: '核心概念', keywords: ['long-term fertilization', 'manuring'] }],
    queries: [{ query: '("long-term fertilization") "soil organic carbon"', rationale: '宽口径' }]
  });
  let seen = '';
  const plan = await rq.planQueries({
    idea: '我想看看长期施肥对土壤碳的影响',
    modelCfg: {},
    callModel: async (cfg, messages) => { seen = messages[0].content; return planReply; }
  });
  ok(plan.queries.length === 1 && plan.queries[0].query.includes('soil organic carbon'), '解析出候选检索式');
  ok(plan.dimensions.length === 1 && plan.dimensions[0].keywords.length === 2, '解析出检索维度与关键词');
  ok(seen.includes('Google Scholar') && seen.includes('3 条不同角度'), '提示词要求给出多条不同角度的检索式');
  let threw = null;
  try { await rq.planQueries({ idea: '  ', callModel: async () => '[]' }); } catch (error) { threw = error; }
  ok(!!threw && /研究想法/.test(threw.message), '空想法直接报错');

  console.log('\nS1b 多源选题拆解：按来源分化检索式');
  const multiReply = JSON.stringify({
    dimensions: [{ name: '核心概念', keywords: ['long-term fertilization'] }],
    queries: [{ query: '("long-term fertilization") "soil organic carbon"', rationale: '宽口径' }],
    perSource: [
      { source: 'google-scholar', query: '("long-term fertilization") "soil organic carbon"', rationale: '通用' },
      { source: 'pubmed', query: '"soil organic carbon"[Title/Abstract] AND fertilization[Title/Abstract]', rationale: 'PubMed 字段标签' },
      { source: 'cnki', query: '施肥 土壤有机碳', rationale: '未启用的来源应被丢掉' }
    ]
  });
  let multiPrompt = '';
  const multiPlan = await rq.planQueries({
    idea: '长期施肥对土壤碳的影响',
    sources: ['google-scholar', 'pubmed'],
    modelCfg: {},
    callModel: async (cfg, messages) => { multiPrompt = messages[0].content; return multiReply; }
  });
  ok(multiPlan.sources.length === 2 && multiPlan.sources[1] === 'pubmed', '只保留启用的目标来源');
  ok(multiPlan.perSource.length === 2 && !multiPlan.perSource.some(item => item.source === 'cnki'), '未启用的来源计划被丢掉');
  ok(multiPlan.perSource.some(item => item.source === 'pubmed' && item.query.includes('[Title/Abstract]')), 'PubMed 使用字段标签语法');
  ok(multiPrompt.includes('PubMed') && multiPrompt.includes('字段标签'), '提示词按来源给出语法说明');

  const partialReply = JSON.stringify({
    queries: [{ query: '"soil organic carbon" fertilization', rationale: '通用' }],
    perSource: [{ source: 'google-scholar', query: '"soil organic carbon" fertilization', rationale: '通用' }]
  });
  const fallbackPlan = await rq.planQueries({
    idea: '土壤碳', sources: ['google-scholar', 'openalex'], modelCfg: {},
    callModel: async () => partialReply
  });
  const fallback = fallbackPlan.perSource.find(item => item.source === 'openalex');
  ok(!!fallback && fallback.query === fallbackPlan.queries[0].query, '模型漏写的来源用通用检索式补齐');
  ok(/沿用通用检索式/.test(fallback.rationale), '补齐项明确标注是兜底');

  console.log('\nS2 候选科学问题：空白 + 要点 → 候选');
  let candidatesPromptSeen = '';
  const candReply = JSON.stringify([
    {
      statement: '长期施肥在北方旱地是否同样提高 SOC？',
      hypothesis: '北方旱地长期施肥使 SOC 提升 10% 以上',
      variables: ['SOC 含量', '施肥年限', '土壤类型'],
      boundary: '北方半湿润区旱地，施肥年限≥20 年',
      gapRefs: ['长期施肥在北方旱地土壤的证据不足'],
      basis: [{ id: 'GSC-001', what: 'meta 分析只覆盖水稻土' }],
      feasibility: '需公开的长期定位试验数据集；可证伪'
    },
    { statement: '缺依据的候选', hypothesis: '', variables: [], boundary: '', gapRefs: [], basis: [], feasibility: '' }
  ]);
  const result = await rq.buildCandidates({
    idea: '长期施肥与土壤碳', gaps: GAPS, notes: NOTES, modelCfg: {},
    callModel: async (cfg, messages) => { candidatesPromptSeen = messages[0].content; return candReply; }
  });
  ok(result.candidates.length === 1, '没有依据的候选被过滤掉');
  ok(result.candidates[0].id === 'Q1' && result.candidates[0].statement.includes('北方旱地'), '候选带序号与问题陈述');
  ok(result.candidates[0].basis.length === 1 && result.candidates[0].basis[0].id === 'GSC-001', '候选带文献依据');
  ok(candidatesPromptSeen.includes('不得虚构') && candidatesPromptSeen.includes('gapRefs'), '提示词含"不得虚构"的硬要求');
  ok(candidatesPromptSeen.includes('长期施肥在北方旱地土壤的证据不足'), '提示词带上了真实空白原文');

  console.log('\nS3 材料不足：返回空数组是允许的答案');
  const empty = await rq.buildCandidates({
    idea: 'x', gaps: GAPS, notes: [], modelCfg: {}, callModel: async () => '[]'
  });
  ok(empty.candidates.length === 0, '空数组被接受，不编造');
  threw = null;
  try { await rq.buildCandidates({ idea: 'x', gaps: [], notes: [], callModel: async () => '[]' }); } catch (error) { threw = error; }
  ok(!!threw && /研究空白/.test(threw.message), '没有空白时直接报错');

  console.log('\nS4 问题说明书：选定候选 → 结构化文档');
  let specPromptSeen = '';
  const spec = await rq.buildSpecification({
    idea: '长期施肥与土壤碳',
    candidate: { id: 'Q1', statement: '长期施肥在北方旱地是否同样提高 SOC？', variables: ['SOC 含量'] },
    gaps: GAPS, notes: NOTES, modelCfg: {},
    callModel: async (cfg, messages) => { specPromptSeen = messages[0].content; return '## 研究问题\n\n……\n## 可检验形式\n\n……'; }
  });
  ok(spec.markdown.includes('## 研究问题'), '说明书原样返回');
  ok(specPromptSeen.includes('## 与文献空白的对应') && specPromptSeen.includes('什么结果算支持'), '提示词要求固定小节与可检验形式');
  ok(specPromptSeen.includes('GSC-001'), '提示词带上了文献依据');

  console.log('\nS5 人工初筛：只对保留的候选抽要点');
  const records = [
    { candidate_id: 'GSC-001', title: 'A' },
    { candidate_id: 'GSC-002', title: 'B' },
    { candidate_id: 'GSC-003', title: 'C' }
  ];
  const kept = research.applyScreening(records, { keep: ['GSC-001', 'GSC-003'], exclude: [{ id: 'GSC-003', reason: '与主题不符' }] });
  ok(kept.records.length === 1 && kept.records[0].candidate_id === 'GSC-001', '排除项与未勾选项都被剔掉');
  ok(kept.excluded.length === 2, '排除清单含两条');
  ok(kept.excluded.find((x) => x.id === 'GSC-003').reason === '与主题不符', '保留人工填的排除理由');
  const noScreen = research.applyScreening(records, null);
  ok(noScreen.records.length === 3, '没有初筛记录时全部保留');

  console.log('\nS6 初筛结果落盘后被要点抽取读取');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-screen-test-'));
  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({
    version: 2, source: 'Google Scholar', query: 'q', count: 3,
    records: records.map((r) => ({ ...r, snippet: 's' }))
  }));
  fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'research', 'screening.json'), JSON.stringify({ keep: ['GSC-001'], exclude: [] }));
  const loaded = research.loadScreening(dir);
  ok(loaded && loaded.keep[0] === 'GSC-001', 'screening.json 被读到');
  const job = { id: 't', dir, config: { topic: 'x', query: 'q' }, files: [] };
  const out = await research.runResearchStage({
    job, modelCfg: {},
    callModel: async () => JSON.stringify([{ id: 'GSC-001', question: 'q', data: 'd', method: 'm', conclusion: 'c', limitation: 'l' }])
  });
  ok(out.notes.length === 1 && out.notes[0].id === 'GSC-001', '只对初筛保留的一篇抽了要点');
  ok(out.meta.screened_count === 1 && out.meta.excluded_count === 2, 'meta 记录了初筛后的数量');
  ok(out.files.includes('research/screening_result.json'), '产出初筛留档');

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  if (failed) { console.error('RESEARCH_QUESTION_TESTS_FAIL'); process.exit(1); }
  console.log('RESEARCH_QUESTION_TESTS_PASS');
})().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
