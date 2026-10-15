'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { fetchSource, privateAddress, MAX_BYTES } = require('./source-download');
const { CodexBridge } = require('./codex-bridge');

// Controlled public source responses: no model calls, credentials or research data.
async function main() {
  const bytes = Buffer.from('Year,Country,Value\n1992,004,-11\n');
  const lookup = async () => [{ address: '93.184.216.34' }];
  const source = { url: 'https://data.example.org/original.csv' };
  const options = { lookup, fetch: async () => new Response(bytes, { headers: { 'content-type': 'text/csv' } }) };
  const result = await fetchSource(source, options);
  assert.equal(result.name, 'original.csv');
  assert.deepEqual(result.data, bytes);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.size, bytes.length);

  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(privateAddress(address), true, address);
  assert.equal(privateAddress('93.184.216.34'), false);
  await assert.rejects(fetchSource({ url: 'http://localhost/a.csv' }, options), /私网/);
  await assert.rejects(fetchSource(source, { ...options, lookup: async () => [{ address: '10.0.0.1' }] }), /私网/);
  await assert.rejects(fetchSource({ url: 'file:///a.csv' }, options), /HTTP/);
  for (const name of ['../original.csv', 'original.exe', 'original:secret.csv', 'CON.txt']) await assert.rejects(fetchSource({ ...source, name }, options), /文件名/);
  await assert.rejects(fetchSource(source, { ...options, fetch: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) }), /网页/);
  await assert.rejects(fetchSource(source, { ...options, fetch: async () => new Response('', { headers: { 'content-type': 'text/csv' } }) }), /为空/);
  await assert.rejects(fetchSource(source, { ...options, fetch: async () => new Response(bytes, { headers: { 'content-length': String(MAX_BYTES + 1) } }) }), /20MB/);
  await assert.rejects(fetchSource(source, { ...options, fetch: async () => new Response(new Uint8Array(MAX_BYTES + 1)) }), /20MB/);
  let calls = 0;
  await assert.rejects(fetchSource(source, { ...options, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.csv' } }); } }), /私网/);
  assert.equal(calls, 1, 'Private redirects must not be fetched');
  calls = 0;
  const redirected = await fetchSource(source, { ...options, fetch: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/final.csv' } }) : new Response(bytes) });
  assert.equal(redirected.finalUrl, 'https://data.example.org/final.csv');
  assert.deepEqual(redirected.data, bytes);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-source-test-'));
  try {
    const bridge = new CodexBridge(root);
    const download = bridge.createSession().id;
    const clean = bridge.createSession().id;
    const saved = bridge.saveSource(download, result, { ok: true, source, rules: '1992，保留库存负号', size: result.size, sha256: result.sha256 });
    const rawPath = bridge.download(download, 'input', saved.download.storedName);
    const report = JSON.parse(fs.readFileSync(bridge.download(download, 'output', saved.download.reportName), 'utf8'));
    assert.equal(report.rules, '1992，保留库存负号');
    assert.equal(report.sha256, result.sha256);
    assert.equal(report.ok, true);
    const imported = bridge.importInput(clean, download, [saved.download.storedName]);
    assert.equal(imported.names.length, 1);
    assert.deepEqual(fs.readFileSync(bridge.download(clean, 'input', imported.names[0])), bytes);
    assert.deepEqual(fs.readFileSync(rawPath), bytes, 'Original input must remain unchanged');
    assert.throws(() => bridge.importInput(clean, download, ['../output/' + saved.download.reportName]), /不可访问/);
    bridge.sourceBusy.add(download);
    assert.throws(() => bridge.importInput(clean, download, [saved.download.storedName]), /正在进行/);
    bridge.sourceBusy.delete(download);
    const failed = bridge.saveSource(download, null, { ok: false, source, rules: report.rules, error: 'HTTP 404' });
    assert.equal(failed.download.ok, false);
    assert.equal(failed.download.storedName, null);
    assert.deepEqual(fs.readFileSync(rawPath), bytes, 'Failure must not overwrite previous successful files');
    console.log('SOURCE_DOWNLOAD_TESTS_PASS (bytes, redirects, limits, records, unchanged originals, cleaning handoff)');
  } finally {
    const checked = path.resolve(root);
    if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('yanxu-source-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(checked, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
