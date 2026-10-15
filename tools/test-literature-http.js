'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8213;
const BASE = `http://127.0.0.1:${PORT}`;

async function ready() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(BASE + '/index.html')).status === 200) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  try {
    await ready();
    let response = await fetch(BASE + '/api/literature/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'test' })
    });
    assert.equal(response.status, 403, 'browser write header is required');
    response = await fetch(BASE + '/api/literature/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' }, body: JSON.stringify({ query: '' })
    });
    assert.equal(response.status, 400, 'missing config cannot start a job');
    response = await fetch(BASE + '/api/literature/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': '1' },
      body: JSON.stringify({ config: { topic: 'test', query: 'test', sources: ['google-scholar', 'scopus'] } })
    });
    assert.equal(response.status, 400, 'unsupported source must not silently run Scholar only');
    response = await fetch(BASE + '/api/literature/job?id=bad');
    assert.equal(response.status, 400, 'invalid job id must be rejected');
    response = await fetch(BASE + '/api/literature/download?id=bad&name=../job.json');
    assert.equal(response.status, 400, 'download traversal must be rejected');
    console.log('LITERATURE_HTTP_TESTS_PASS');
  } finally { child.kill('SIGTERM'); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
