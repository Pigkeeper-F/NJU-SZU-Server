'use strict';
// Explicit, isolated smoke test. Uses the real local Codex connection; no papers or source requests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CodexBridge } = require('./codex-bridge');
const { runScreeningStage } = require('./literature-screening');
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Real-model smoke requires --live');
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(root, '.workbench', 'screening-smoke-'));
  const bridge = new CodexBridge(root);
  const config = { screeningPolicy: { id: 'ISOLATED-SMOKE-PRODUCTION', line: 'production', text: '本测试只纳入肉鸡整体动物的原始生长试验，需实际环境温度对照，日粮相同，至少报告增重。只有化学材料且无动物试验明确排除。证据不清或缺摘要留待定并取全文，不能虚构。' } };
  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({records: [
    { candidate_id: 'SMOKE_INCLUDE', source_key: 'fixture', title: 'Synthetic test: heat exposure and broiler weight gain', abstract: 'This is a synthetic test record, not a publication. Broiler chickens were randomly allocated to 24 C or 32 C ambient air for 21 days. Both groups received the same basal diet. Body weight gain was measured in each group.', keywords: ['broiler', 'ambient temperature', 'weight gain'] },
    { candidate_id: 'SMOKE_EXCLUDE', source_key: 'fixture', title: 'Synthetic test: thermal properties of a copper catalyst', abstract: 'This is a synthetic test record, not a publication. We measured chemical properties of a copper catalyst. No animals or animal tissues were studied.', keywords: ['catalyst', 'temperature'] },
    { candidate_id: 'SMOKE_PENDING', source_key: 'fixture', title: 'Synthetic test: growth in broilers under heat stress', snippet: 'A short search preview only.' }
  ] }), 'utf8');
  const started = Date.now();
  try {
    const result = await runScreeningStage({ root, bridge, jobDir: dir, config, timeoutMs: 120000, maxRuntimeMs: 300000,
      onEvent: e => { if (e.type === 'stage') console.log(e.message); } });
    assert.deepEqual(result.counts, {include:1, pending:1, exclude:1});
    const resumed = await runScreeningStage({ root, bridge, jobDir: dir, config });
    assert.equal(resumed.reused, 3);
    const report = {ok:true, synthetic:true, formalSearchStarted:false, downloadsStarted:false, elapsedMs:Date.now()-started, counts:result.counts, resumed:resumed.reused, evidenceDir:dir};
    fs.writeFileSync(path.join(dir, 'smoke-result.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
  } finally { bridge.proc?.kill(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
