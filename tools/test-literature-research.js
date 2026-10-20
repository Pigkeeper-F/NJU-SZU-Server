'use strict';
/**
 * 文献调研环节（环节①）的回归测试：mock 模型，不联网。
 *
 * 覆盖：
 *   S1 候选读取 + 逐篇要点抽取（mock 返回 JSON 数组）
 *   S2 横向归纳（mock 返回 consensus / disagreements / gaps）
 *   S3 产物落盘：notes.json / notes.csv / synthesis.json / synthesis.md / gaps.json / gaps.md
 *   S4 诚实性：仅题录的文献不得被补出实质结论（mock 返回空字段时应落到"文中未说明"）
 *   S5 模型输出不合法（脏 JSON）时不崩，如实记 error
 *   S6 没有候选时报错而不是产出空壳
 *
 * 用法：node tools/test-literature-research.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const research = require('./literature-research');

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.log('  ✗ ' + label); }
}

function makeJob(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-research-test-'));
  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({
    version: 2, source: 'Google Scholar', query: 'soil carbon', search_url: 'https://example.test',
    retrieved_at: '2026-10-20T00:00:00Z', count: records.length, scope: 'first_page_candidates_only',
    records
  }, null, 2));
  return { id: 'test-job', dir, config: { topic: '土壤碳', query: 'soil carbon' }, files: [] };
}

const RECORDS = [
  {
    candidate_id: 'GSC-001', source: 'Google Scholar', query: 'soil carbon', retrieved_at: '2026-10-20T00:00:00Z',
    title: 'Long-term fertilization and soil carbon in paddy soils',
    byline: 'A Author, B Author - Agriculture, Ecosystems & Environment, 2015', snippet: 'A meta-analysis of long-term trials.',
    doi: '10.1234/abc', year: 2015, authors: 'A Author, B Author', venue: 'Agriculture, Ecosystems & Environment'
  },
  {
    candidate_id: 'GSC-002', source: 'Google Scholar', query: 'soil carbon', retrieved_at: '2026-10-20T00:00:00Z',
    title: 'Manure inputs and organic carbon fractions in red soil',
    byline: 'C Author - Geoderma, 2018', snippet: 'Field study across long-term experiments.',
    doi: '', year: 2018, authors: 'C Author', venue: 'Geoderma'
  }
];

(async () => {
  console.log('文献调研环节回归（mock 模型）');

  console.log('\nS1/S2/S3 正常路径：抽取要点 → 归纳 → 落盘');
  const job = makeJob(RECORDS);
  const notesReply = JSON.stringify([
    { id: 'GSC-001', question: '长期施肥对稻田 SOC 的影响', data: '长期试验的 meta 分析', method: 'meta 分析', conclusion: '长期施肥提高 SOC', limitation: '未覆盖北方土壤', evidence: '全文' },
    { id: 'GSC-002', question: '粪肥输入与碳组分', data: '长期定位试验', method: '长期定位试验', conclusion: '粪肥提高活性碳', limitation: '样本点少', evidence: '全文' }
  ]);
  const synthesisReply = JSON.stringify({
    consensus: [{ statement: '长期施肥普遍提高土壤有机碳', refs: ['GSC-001', 'GSC-002'] }],
    disagreements: [{ statement: '不同土壤类型响应幅度差异大', refs: ['GSC-001'] }],
    gaps: [{ gap: '长期施肥在北方旱地土壤的证据不足', basis: [{ id: 'GSC-001', what: 'meta 分析只覆盖水稻土' }], direction: '在北方旱地开展长期定位试验' }]
  });
  const calls = [];
  const mockModel = async (cfg, messages, timeout) => {
    calls.push(messages[0].content);
    return calls.length === 1 ? notesReply : synthesisReply;
  };
  const result = await research.runResearchStage({ job, modelCfg: {}, callModel: mockModel });
  ok(result.ok === true, '运行成功');
  ok(result.notes.length === 2, '抽出 2 篇要点');
  ok(result.notes[0].question === '长期施肥对稻田 SOC 的影响', '第一篇要点正确');
  ok(result.synthesis.consensus.length === 1, '归纳出 1 条共识');
  ok(result.synthesis.disagreements.length === 1, '归纳出 1 条分歧');
  ok(result.gaps.length === 1 && result.gaps[0].basis.length === 1, '研究空白带依据');
  ok(result.files.length === 6, '产出 6 个文件');
  for (const rel of result.files) {
    ok(fs.existsSync(path.join(job.dir, rel)), '文件已落盘：' + rel);
  }
  const csv = fs.readFileSync(path.join(job.dir, 'research', 'notes.csv'), 'utf8');
  ok(csv.split('\r\n')[0].includes('question') && csv.includes('长期施肥对稻田 SOC 的影响'), 'CSV 表头与内容正确');
  const gapsMd = fs.readFileSync(path.join(job.dir, 'research', 'gaps.md'), 'utf8');
  ok(gapsMd.includes('北方旱地') && gapsMd.includes('meta 分析只覆盖水稻土'), 'gaps.md 含空白与依据出处');
  ok(calls.length === 2, '模型被调用 2 次（要点 + 综合）');
  ok(calls[0].includes('仅题录') && calls[0].includes('不得推断方法细节'), '要点提示词含"仅题录不得推断"的硬要求');

  console.log('\nS4 诚实性：模型没给出内容的字段落到"文中未说明"');
  const job2 = makeJob(RECORDS);
  const mockSparse = async () => JSON.stringify([
    { id: 'GSC-001', question: '', data: '', method: '', conclusion: '', limitation: '' },
    { id: 'GSC-002' }
  ]);
  const r2 = await research.runResearchStage({ job: job2, modelCfg: {}, callModel: mockSparse });
  ok(r2.notes[0].question === '文中未说明', '空字段落为"文中未说明"');
  ok(r2.notes[0].evidence === '仅题录', '无全文时 evidence 标"仅题录"');
  ok(r2.notes[1].conclusion === '文中未说明', '缺字段的条目同样兜底');

  console.log('\nS5 模型输出不合法：不崩，如实记 error');
  const job3 = makeJob(RECORDS);
  const mockDirty = async () => '这不是 JSON 只是一段闲聊';
  const r3 = await research.runResearchStage({ job: job3, modelCfg: {}, callModel: mockDirty });
  ok(r3.ok === false, '标记为失败');
  ok(typeof r3.error === 'string' && r3.error.length > 0, '带错误说明');
  ok(fs.existsSync(path.join(job3.dir, 'research', 'notes.json')), '仍产出 notes.json（过程留痕）');

  console.log('\nS6 没有候选：报错而不是产出空壳');
  const emptyJob = { id: 'x', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lit-research-empty-')), config: {} };
  let threw = null;
  try {
    await research.runResearchStage({ job: emptyJob, modelCfg: {}, callModel: async () => '[]' });
  } catch (error) { threw = error; }
  ok(!!threw && /候选/.test(threw.message), '抛出"没有检索候选"的错误');

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  if (failed) { console.error('LITERATURE_RESEARCH_TESTS_FAIL'); process.exit(1); }
  console.log('LITERATURE_RESEARCH_TESTS_PASS');
})().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});
