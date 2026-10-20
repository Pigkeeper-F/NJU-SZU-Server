'use strict';

// Real guarded HTTP route; fake connector cannot load jobs or start workers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-review-http-'));
  const repository = path.resolve(__dirname, '..'), allocator = http.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const loader = path.join(root, 'fixture-connector.js');
  fs.writeFileSync(loader, `const file=${JSON.stringify(path.join(repository, 'tools', 'literature-connector.js'))};
require.cache[file]={id:file,filename:file,loaded:true,exports:{LiteratureConnector:class{
constructor(){this.jobs=new Map();}
reviewFulltext(id){return {id,status:'running',stage:'fulltext_review'};}
}}};`);
  const child = spawn(process.execPath, ['--require', loader, path.join(repository, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/index.html')).ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'isolated server must start');
    const post = (body, extra = {}) => fetch(base + '/api/literature/review-fulltext', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1', ...extra }, body: JSON.stringify(body)
    });
    let response = await post({ id: 'original-paused-job' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id: 'original-paused-job', status: 'running', stage: 'fulltext_review' });
    response = await post({ id: 'original-paused-job' }, { 'X-Workbench': '' });
    assert.equal(response.status, 403);
    response = await post({ id: 'original-paused-job' }, { Origin: 'https://external.example' });
    assert.equal(response.status, 403);
    response = await post({ id: 'original-paused-job', until: 'dedupe', confirmations: { rules: true } });
    assert.equal(response.status, 400, 'offline review accepts only the task id');
    response = await post([]);
    assert.equal(response.status, 400);
    console.log('LITERATURE_FULLTEXT_REVIEW_HTTP_TESTS_PASS');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-review-http-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
