'use strict';
// Test actual read-only HTTP routes on an isolated local service, with a fake
// connector that cannot execute or access real task directories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-materials-http-'));
  const repository = path.resolve(__dirname, '..'), allocator = http.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const expected = { schema: 1, legacy: true, papers: [{ paper_id: 'CNKI-001', title: 'Fixture', main_pdf_status: 'missing',
    supplement_check: { status: 'uninspected', reason: 'Never checked' }, materials: [] }] };
  const loader = path.join(root, 'fixture-connector.js');
  fs.writeFileSync(loader, `const file=${JSON.stringify(path.join(repository, 'tools/literature-connector.js'))};
require.cache[file]={id:file,filename:file,loaded:true,exports:{LiteratureConnector:class{
constructor(){this.jobs=new Map();}
materials(id){if(id!=='fixture-job')throw new Error('unknown');return ${JSON.stringify(expected)};}
download(){throw new Error('raw manifest must not be sent');}
}}};`);
  const child = spawn(process.execPath, ['--require', loader, path.join(repository, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/index.html')).ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready);
    let response = await fetch(base + '/api/literature/materials?id=fixture-job');
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    response = await fetch(base + '/api/literature/download?id=fixture-job&name=fulltext%2Fmaterials.json');
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await response.json(), expected, 'manifest download is the safe projection, never raw file bytes');
    response = await fetch(base + '/api/literature/materials?id=fixture-job', { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(response.status, 403);
    response = await fetch(base + '/api/literature/materials?id=unknown'); assert.equal(response.status, 400);
    console.log('LITERATURE_MATERIALS_HTTP_TESTS_PASS');
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-materials-http-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
