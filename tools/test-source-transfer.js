'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const { transferFile, transferArchive, hashFile, writeJson } = require('./source-transfer');
const lookup = async () => [{ address: '93.184.216.34' }];
async function main() {
  const base = path.resolve(__dirname, '../.workbench/test-fixtures'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'yanxu-transfer-'));
  const url = 'https://bulks-faostat.fao.org/production/fixture.zip';
  try {
    // More than the old20MiB limit, produced in bounded chunks.
    const total = 21 * 1024 ** 2, block = Buffer.alloc(65536, 42);
    const target = path.join(dir, 'large.part'); let count = 0;
    await transferFile('https://public.fixture.org/data.csv', target, { lookup, fetch: async () => ({ ok: true, status: 200,
      headers: { get: key => key === 'content-length' ? String(total) : 'application/octet-stream' },
      body: Readable.from((async function* () { for (let bytes = 0; bytes < total; bytes += block.length) yield block; })()) }), onProgress: () => count++ });
    assert.equal(fs.statSync(target).size, total); assert.ok(count > 1); assert.equal((await hashFile(target)).length, 64);
    const bytes = Buffer.from([80,75,3,4,1,2,3,4,5,6]);
    const partial = path.join(dir, 'resume.part'); fs.writeFileSync(partial, bytes.subarray(0, 5)); writeJson(partial + '.transfer.json', { source: url, etag: 'fixture', totalBytes: bytes.length });
    const resumed = await transferArchive(url, partial, { lookup, fetch: async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=5-'); assert.equal(options.headers['If-Range'], 'fixture');
      return new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': 'bytes 5-9/10', 'content-length': '5', etag: 'fixture' } });
    } });
    assert.equal(resumed.resumedBytes, 5); assert.deepEqual(fs.readFileSync(partial), bytes);
    // A server that ignores Range must replace the partial file rather than concatenate it.
    fs.writeFileSync(partial, bytes.subarray(0, 5));
    await transferArchive(url, partial, { lookup, fetch: async () => new Response(bytes, { headers: { 'content-length': '10' } }) });
    assert.deepEqual(fs.readFileSync(partial), bytes);
    await assert.rejects(transferArchive('https://evil.fixture.org/fixture.zip', partial, { lookup }), /官方/);
    await assert.rejects(transferFile('http://127.0.0.1/a.csv', partial, { lookup }), /私网/);
    await assert.rejects(transferArchive(url, partial, { lookup, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.fixture.org/file.zip' } }) }), /官方/);
    await assert.rejects(transferFile('https://public.fixture.org/a.csv', path.join(dir, 'html.part'), { lookup, fetch: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) }), /未返回/);
    await assert.rejects(transferArchive(url, path.join(dir, 'huge.part'), { lookup, maxBytes: 9, fetch: async () => new Response(bytes, { headers: { 'content-length': '10' } }) }), /上限/);
    assert.equal(fs.existsSync(path.join(dir, 'huge.part')), false);
    console.log('SOURCE_TRANSFER_TESTS_PASS (large stream, Range resume, restart, public DNS and official redirects)');
  } finally { if (path.dirname(dir) !== base || !path.basename(dir).startsWith('yanxu-transfer-')) throw new Error('Unexpected test root'); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
