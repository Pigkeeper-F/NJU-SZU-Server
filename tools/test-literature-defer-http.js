'use strict';

// Exercise the real guarded HTTP route with a connector stand-in. It receives
// options but never loads tasks, starts Python, opens a browser, or writes jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'literature-defer-http-'));
  const repository = path.resolve(__dirname, '..');
  const allocator = http.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const loader = path.join(temporary, 'fixture-connector.js');
  fs.writeFileSync(loader, `'use strict';
const file = ${JSON.stringify(path.join(repository, 'tools', 'literature-connector.js'))};
require.cache[file] = { id:file, filename:file, loaded:true, exports:{ LiteratureConnector: class {
  constructor() { this.jobs = new Map(); }
  advance(id, options) { return { id, received: options }; }
} } };
`);
  const child = spawn(process.execPath, ['--require', loader, path.join(repository, 'server.js')], {
    cwd: temporary, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/index.html')).ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'isolated HTTP route fixture must start');
    const post = (body, extra = {}) => fetch(base + '/api/literature/advance', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1', ...extra }, body: JSON.stringify(body)
    });
    let response = await post({ id: 'same-original-task', deferSource: 'web-of-science' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'same-original-task', received: { deferSource: 'web-of-science' } });
    response = await post({ id: 'same-original-task', until: 'dedupe' });
    assert.deepEqual(await response.json(), { id: 'same-original-task', received: { until: 'dedupe' } });
    response = await post({ id: 'same-original-task', deferSource: 'web-of-science' }, { 'X-Workbench': '' });
    assert.equal(response.status, 403);
    response = await post({ id: 'same-original-task', deferSource: 'web-of-science' }, { Origin: 'https://external.example' });
    assert.equal(response.status, 403);
    console.log('LITERATURE_DEFER_HTTP_TESTS_PASS');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const absolute = path.resolve(temporary);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('literature-defer-http-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
