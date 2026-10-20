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
async function main() {
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
