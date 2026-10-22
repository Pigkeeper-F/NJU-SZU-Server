'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { SourceDownloads, interpretPlan, validatePlan } = require('./faostat-download');
const { transferArchive, transferFile, hashFile, writeJson } = require('./source-transfer');
const { CodexBridge } = require('./codex-bridge');
const project = path.resolve(__dirname, '..');
const python = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const lookup = async () => [{ address: '93.184.216.34' }];
async function terminal(downloads, session, id) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const job = downloads.snapshot(session, id); if (job.status !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('fixture job timeout');
}
async function testPlanInterpretation() {
  // Same structure and technical pending notes as the real failed task; this is
  // a standalone fixture, so regression tests never load or change user state.
  const structured = `## 环节目标

制定并提交 **FAOSTAT 详细贸易矩阵（Detailed trade matrix，TM）2024 年小麦（Wheat）贸易数量数据**下载方案。

## 输入与数据说明

| 项目 | 已确认规则或待确认事项 |
|---|---|
| 数据来源 | FAOSTAT 官方详细贸易矩阵（TM）；具体入口、访问时的数据集名称和可用下载地址待官方核对 |
| 目标年份 | 已确认采用 2024 年；数据可用性待官方核对 |
| 商品范围 | 已确认仅为小麦（Wheat）；正式名称及商品代码待官方核对，不扩展至小麦制品或其他相关商品；如有多个可能对应条目，须交研究者选择 |
| 报告国范围 | 已确认采用全部报告国，以 TM 官方实际分类为准，包含官方提供的区域等汇总项及代码 |
| 贸易伙伴范围 | 已确认采用全部贸易伙伴，以 TM 官方实际分类为准，包含官方提供的区域等汇总项及代码 |
| 进出口指标 | 已确认采用进口数量、出口数量，不含贸易金额；正式指标名称、代码和单位待官方核对 |
| 获取方式 | 待研究者确认；优先核对官方按条件导出 CSV 的路径，同时核对官方完整压缩包路径 |
| 完整压缩包 | 仅为候选方式；具体链接、文件大小、覆盖范围、内部文件构成和版本待官方核对 |
| 超过 20MB 的文件 | 旧 AI 草稿：先提出调整后的获取方案并记录原因，经研究者确认后执行；具体替代方式待确认 |

## 注意事项

- 官方完整压缩包仍为候选获取方式，尚未批准采用。
- 本文仅修订方案文字，不代表已完成官方核验、下载、解压、检查或运行。`;
  const parsed = await interpretPlan(structured);
  assert.deepEqual(parsed.years, [2024]);
  assert.deepEqual(parsed.filters, { elementNames: ['Import quantity', 'Export quantity'], itemNames: ['Wheat'] }, '自然语言范围交给官方字典核对，不添加猜测代码或隐含国家筛选');
  let generated = 0;
  const parsedWithAssistant = await interpretPlan(structured, async () => { generated++; throw new Error('确定范围不应交回模型索要代码/链接'); });
  assert.deepEqual(parsedWithAssistant, parsed);
  assert.equal(generated, 0, '已确认的表格范围应确定性提取，旧技术待核对文字不阻挡');
  for (const [label, modified] of [
    ['禁止整包', structured + '\n- 禁止整包下载，仅允许按条件直接导出。'],
    ['不允许完整压缩包', structured + '\n- 不允许下载完整压缩包。'],
    ['限定报告国', structured.replace('已确认采用全部报告国，以 TM 官方实际分类为准', '已确认仅限中国（China），以 TM 官方实际分类为准')],
    ['限定伙伴国', structured.replace('已确认采用全部贸易伙伴，以 TM 官方实际分类为准', '已确认仅限阿富汗（Afghanistan），以 TM 官方实际分类为准')],
    ['全部中的子集', structured.replace('已确认采用全部报告国，以 TM 官方实际分类为准', '全部报告国中仅选择中国（China），以 TM 官方实际分类为准')],
    ['混合金额', structured.replace('进口数量、出口数量，不含贸易金额', '进口数量、出口数量、进口金额')]
  ]) {
    let consulted = false;
    await assert.rejects(interpretPlan(modified, async () => {
      consulted = true;
      return JSON.stringify({ dataset: 'TM', years: [2024], unresolved: ['复杂或受限方案须另行解析'] });
    }), /复杂或受限方案/, label);
    assert.equal(consulted, true, '显式禁止整包、非全部国家、混合金额范围均不得走确定性捷径');
  }
  const scoped = 'FAOSTAT TM 2024 年；商品 Wheat；报告国 China；贸易伙伴 Afghanistan；进口数量和出口数量。';
  const config = validatePlan({ dataset: 'TM', years: [2024], filters: {
    itemNames: ['Wheat'], reporterNames: ['China'], partnerNames: ['Afghanistan'], elementNames: ['IMPORT QUANTITY', 'Export quantity']
  } }, scoped);
  assert.deepEqual(config.filters.itemNames, ['Wheat']);
  assert.deepEqual(config.filters.reporterNames, ['China']);
  assert.deepEqual(config.filters.partnerNames, ['Afghanistan']);
  assert.deepEqual(config.filters.elementNames, ['IMPORT QUANTITY', 'Export quantity']);
  for (const filters of [
    { itemCodes: ['15'] }, { reporterCodes: ['41'] }, { partnerCodes: ['2'] }, { elementCodes: ['5610'] },
    { itemNames: ['Maize'] }, { reporterNames: ['France'] }, { partnerNames: ['Pakistan'] },
    { elementNames: ['Import Value'] }, { elementNames: ['invented element'] }
  ]) assert.throws(() => validatePlan({ dataset: 'TM', years: [2024], filters }, scoped), /明确|名称|依据/, '模型不能制造方案未提供的名称、代码或指标');
}
async function main() {
  await testPlanInterpretation();
  const base = path.join(project, '.workbench/test-fixtures'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'faostat-job-'));
  try {
    fs.mkdirSync(path.join(root, 'tools')); fs.copyFileSync(path.join(project, 'tools/faostat_filter.py'), path.join(root, 'tools/faostat_filter.py'));
    const fixture = path.join(root, 'fixture.zip');
    const created = spawnSync(python, [path.join(project, 'tools/make-test-faostat-fixture.py'), fixture], { encoding: 'utf8', windowsHide: true });
    assert.equal(created.status, 0, created.stderr); const meta = JSON.parse(created.stdout);
    assert.ok(meta.size > 20 * 1024 ** 2);
    const plan = 'FAOSTAT TM 2024 年贸易矩阵；保留原始字段、数值和Flag；其他国家商品指标全部保留。';
    assert.deepEqual((await interpretPlan(plan)).years, [2024]);
    assert.throws(() => validatePlan({ dataset: 'TM', years: [2023] }, plan), /年份/);
    assert.throws(() => validatePlan({ dataset: 'TM', years: [2024], filters: { reporterCodes: ['41'] } }, plan), /明确/);
    await assert.rejects(interpretPlan(plan, async () => JSON.stringify({ dataset: 'TM', years: [2024], unresolved: ['国家限定尚不明确'] })), /国家限定/);
    const bridge = new CodexBridge(root), session = bridge.createSession().id;
    let transfers = 0;
    const catalog = { DatasetCode: 'TM', FileLocation: 'https://bulks-faostat.fao.org/production/TM_fixture.zip', DateUpdate: 'fixture-v1', FileRows: meta.rows };
    const options = { python,
      fetchCatalog: async () => ({ data: Buffer.from(JSON.stringify({ Datasets: { Dataset: [catalog] } })) }),
      transferArchive: (url, dest, settings) => { transfers++; return transferArchive(url, dest, { ...settings, lookup, fetch: async () => new Response(Readable.toWeb(fs.createReadStream(fixture)), { headers: { 'content-length': String(meta.size), etag: 'fixture-v1' } }) }); }
    };
    const downloads = new SourceDownloads(root, bridge, options);
    const start = downloads.start(session, plan);
    assert.equal(bridge.active(session), true); assert.throws(() => downloads.start(session, plan), /运行/);
    const job = await terminal(downloads, session, start.id);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.sourceRows, meta.rows); assert.equal(job.result.rowsSelected, meta.selected2024);
    assert.ok(job.deliverables[0].size > 20 * 1024 ** 2, '年文件超过旧20MB限制也应正常保存');
    assert.equal(job.result.zipCRCVerified, true);
    const archive = bridge.download(session, 'output', job.archive.name);
    assert.equal(await hashFile(archive), await hashFile(fixture));
    const selected = bridge.download(session, 'input', job.deliverables[0].storedName);
    const prefix = Buffer.alloc(1500), fd = fs.openSync(selected, 'r'); try { fs.readSync(fd, prefix); } finally { fs.closeSync(fd); }
    assert.match(prefix.toString('utf8'), /004/); assert.match(prefix.toString('utf8'), /2024/);
    const clean = bridge.createSession().id;
    const copied = bridge.importInput(clean, session, [job.deliverables[0].storedName]);
    assert.equal(await hashFile(bridge.download(clean, 'input', copied.names[0])), job.deliverables[0].sha256, '大文件交接保持原件不变');
    const originalStat = fs.statSync(archive);
    const second = await terminal(downloads, session, downloads.start(session, plan).id);
    assert.equal(second.status, 'completed', second.error); assert.equal(transfers, 1, '同一完整官方包校验后复用');
    assert.equal(fs.statSync(archive).mtimeMs, originalStat.mtimeMs, '旧结果不覆盖');
    assert.throws(() => downloads.resume(session, job.id, plan + '改范围'), /方案已修改/);
    // Recover an interrupted persisted job; resume must reuse its frozen plan/catalog.
    const state = downloads.load(session, job.id); state.status = 'running'; downloads.save(state);
    const restarted = new SourceDownloads(root, bridge, { ...options, recover: true });
    assert.equal(restarted.snapshot(session, job.id).status, 'interrupted');
    const recovered = await terminal(restarted, session, restarted.resume(session, job.id, plan).id);
    assert.equal(recovered.status, 'completed', recovered.error); assert.equal(transfers, 1);
    // The same job interface also saves a general public file larger than20MiB.
    const general = new SourceDownloads(root, bridge, { transferFile: (url, dest, settings) => transferFile(url, dest, { ...settings, lookup, fetch: async () => new Response(Readable.toWeb(fs.createReadStream(fixture)), { headers: { 'content-length': String(meta.size) } }) }) });
    const generic = await terminal(general, clean, general.start(clean, '获取此公开原始文件 https://public.fixture.org/source.zip').id);
    assert.equal(generic.kind, 'files'); assert.equal(generic.status, 'completed', generic.error); assert.equal(generic.deliverables[0].size, meta.size);
    // Explicit cancellation keeps the old completed deliverables and releases the session lock.
    const delayed = new SourceDownloads(root, bridge, { ...options, fetchCatalog: async () => ({ data: Buffer.from(JSON.stringify({ Datasets: { Dataset: [{ ...catalog, DateUpdate: 'fixture-v2' }] } })) }),
      transferArchive: (_url, file, settings) => new Promise((_yes, no) => { fs.writeFileSync(file, Buffer.from('PK\x03\x04')); settings.onProgress({ bytes: 4, totalBytes: meta.size }); settings.signal.addEventListener('abort', () => no(new Error('stopped')), { once: true }); }) });
    const cancelled = delayed.start(session, plan);
    while (delayed.snapshot(session, cancelled.id).stage !== 'download') await new Promise(resolve => setTimeout(resolve, 10));
    delayed.cancel(session, cancelled.id);
    assert.equal((await terminal(delayed, session, cancelled.id)).status, 'cancelled');
    assert.equal(Boolean(bridge.active(session)), false); assert.ok(fs.existsSync(archive));
    console.log('FAOSTAT_DOWNLOAD_TESTS_PASS (large ZIP to year CSV, preserved codes/flags, hash, cache, restart, cancellation and large handoff)');
  } finally {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('faostat-job-')) throw new Error('Unexpected test root');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
