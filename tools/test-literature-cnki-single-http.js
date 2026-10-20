'use strict';

// Actual HTTP guards and exact route shape; never loads real user jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-cnki-http-'));
  const repository = path.resolve(__dirname, '..'), allocator = http.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const loader = path.join(root, 'fixture-connector.js');
  fs.writeFileSync(loader, `const file=${JSON.stringify(path.join(repository, 'tools', 'literature-connector.js'))};
require.cache[file]={id:file,filename:file,loaded:true,exports:{LiteratureConnector:class{
constructor(){this.jobs=new Map();}
retryCnki(id,paperId){return {id,paperId,status:'running'};}
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
    assert.ok(ready, 'isolated server must start');
    const post = (body, headers = {}) => fetch(base + '/api/literature/retry-cnki', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1', ...headers }, body: JSON.stringify(body)
    });
    let response = await post({ id: 'original-job', paperId: 'CNKI-007' });
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { id: 'original-job', paperId: 'CNKI-007', status: 'running' });
    for (const extra of [{ 'X-Workbench': '' }, { Origin: 'https://other.example' }]) {
      response = await post({ id: 'original-job', paperId: 'CNKI-007' }, extra); assert.equal(response.status, 403);
    }
    for (const body of [[], {}, { id: 'original-job' }, { paperId: 'CNKI-007' },
      { id: 'original-job', paperId: 'CNKI-007', url: 'https://example.org/session' },
      { id: 'original-job', paperId: 'CNKI-007', limit: 13 }, { id: 'original-job', paperId: 'CNKI-007', until: 'export' }]) {
      response = await post(body); assert.equal(response.status, 400, 'single retry accepts only id and paperId');
    }
    console.log('LITERATURE_CNKI_SINGLE_HTTP_TESTS_PASS');
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-cnki-http-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
