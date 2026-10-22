'use strict';

// Isolated code copies and mock job holders; never starts a user task or database browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { workspaceIdFor, backendFingerprint, createLiteratureRuntime } = require('./literature-runtime');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_KEYS = ['protocolVersion', 'instanceId', 'startedAt', 'pid', 'port', 'workspaceId', 'loadedFingerprint',
  'restartRequired', 'supportedSources', 'busy', 'browserSession'];
const SOURCES = ['google-scholar', 'cnki', 'wanfang', 'web-of-science', 'scopus', 'pubmed'];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sourceFixture(root) {
  write(path.join(root, 'tools', 'literature-sources.js'), fs.readFileSync(path.join(ROOT, 'tools', 'literature-sources.js')));
  write(path.join(root, 'tools', 'literature-sources.json'), JSON.stringify({ sources: SOURCES.map(key => ({ key, state: 'executable' })) }));
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(base, child, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Runtime fixture exited: ' + output());
    try {
      const response = await fetch(base + '/api/literature/runtime', { headers: { Connection: 'close' } });
      if (response.ok) return;
    } catch (_) { /* The fixture is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Runtime fixture did not start: ' + output());
}

function checkShape(snapshot) {
  assert.deepEqual(Object.keys(snapshot), EXPECTED_KEYS);
  assert.equal(snapshot.protocolVersion, 1);
  assert.match(snapshot.instanceId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(snapshot.startedAt)));
  assert.ok(Number.isInteger(snapshot.pid) && snapshot.pid > 0);
  assert.match(snapshot.workspaceId, /^[a-f0-9]{64}$/);
  assert.match(snapshot.loadedFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.browserSession, 'persistent-research-browser');
}

function unitCases(root) {
  sourceFixture(root);
  write(path.join(root, 'server.js'), '// fixture backend\n');
  assert.equal(workspaceIdFor(root), workspaceIdFor(path.join(root, '.')));
  assert.notEqual(workspaceIdFor(root), workspaceIdFor(path.join(root, 'other')));
  const before = backendFingerprint(root);
  let busy = false;
  const runtime = createLiteratureRuntime({ root, port: 8123, isBusy: () => busy });
  const first = runtime.snapshot();
  checkShape(first);
  assert.equal(first.workspaceId, workspaceIdFor(root));
  assert.equal(first.loadedFingerprint, before);
  assert.deepEqual(first.supportedSources, SOURCES);
  assert.equal(first.restartRequired, false);
  assert.equal(first.busy, false);
  busy = true;
  assert.equal(runtime.snapshot().busy, true);
  const stable = runtime.snapshot();
  assert.equal(stable.instanceId, first.instanceId);
  assert.equal(stable.startedAt, first.startedAt);
  first.supportedSources.push('invented-source');
  assert.deepEqual(runtime.snapshot().supportedSources, SOURCES, 'Returned arrays must not mutate the loaded capability snapshot');

  write(path.join(root, 'js', 'codex.js'), '// new frontend\n');
  write(path.join(root, 'css', 'style.css'), 'body {}\n');
  write(path.join(root, '.env'), 'AI_API_KEY=fixture-secret-not-in-runtime\n');
  write(path.join(root, '.workbench', 'literature', 'fixture', 'job.json'), '{"status":"running"}\n');
  assert.equal(backendFingerprint(root), before, 'Static files, credentials and tasks cannot alter the backend fingerprint');
  assert.equal(runtime.snapshot().restartRequired, false);
  assert.ok(!JSON.stringify(runtime.snapshot()).includes('fixture-secret-not-in-runtime'));
  assert.ok(!JSON.stringify(runtime.snapshot()).includes(root), 'Runtime response must not reveal the absolute workspace path');

  for (const moduleName of ['literature_fulltext_reuse.py', 'literature_target_groups.py']) {
    const prior = backendFingerprint(root);
    write(path.join(root, 'tools', moduleName), '# changed local full-text behavior\n');
    assert.notEqual(backendFingerprint(root), prior, moduleName + ' must invalidate the loaded backend');
  }

  const changed = { sources: [{ key: 'google-scholar', state: 'executable' }, { key: 'pubmed', state: 'registered' }] };
  write(path.join(root, 'tools', 'literature-sources.json'), JSON.stringify(changed));
  assert.notEqual(backendFingerprint(root), before);
  const outdated = runtime.snapshot();
  assert.equal(outdated.restartRequired, true);
  assert.deepEqual(outdated.supportedSources, SOURCES, 'Disk changes must not impersonate the sources already loaded by the process');
  assert.equal(outdated.loadedFingerprint, before);
  write(path.join(root, 'tools', 'literature_browser.py'), '# new page adapter\n');
  assert.equal(runtime.snapshot().restartRequired, true);
  assert.equal(createLiteratureRuntime({ root, port: 8123, isBusy: () => { throw new Error('fixture unknown work state'); } }).snapshot().busy, true);
  assert.throws(() => createLiteratureRuntime({ root, port: -1 }), /端口无效/);
}

async function httpCases(root) {
  sourceFixture(root);
  for (const name of ['server.js', 'tools/literature-runtime.js', 'tools/source-download.js', 'tools/scholar-flow.js', 'tools/plotting.js',
    'tools/clean-results-view.js', 'tools/clean-results-archive.js', 'tools/faostat-download.js', 'tools/source-transfer.js',
    'tools/literature-fields-assist.js', 'tools/literature-config.js']) {
    write(path.join(root, name), fs.readFileSync(path.join(ROOT, name)));
  }
  // The real server's busy predicate sees fake job holders. Any actual model/login access fails the fixture.
  const controls = `const fs = require('node:fs'); const path = require('node:path');
function control(root) { try { return JSON.parse(fs.readFileSync(path.join(root, '.workbench/runtime-fixture-controls.json'), 'utf8')); } catch (_) { return {}; } }
`;
  write(path.join(root, 'tools/codex-bridge.js'), `'use strict';\n${controls}
class CodexBridge {
  constructor(root) { this.root = root; }
  get jobs() { return new Map([['fixture', { status: control(this.root).codex ? 'running' : 'completed' }]]); }
  get sourceBusy() { return new Set(control(this.root).source ? ['fixture'] : []); }
  get pending() { return new Map(control(this.root).pending ? [['fixture', {}]] : []); }
  get loginStarting() { return control(this.root).loginStarting || null; }
  get loginAttempt() { return control(this.root).loginAttempt || null; }
  status() { throw new Error('Runtime must not call model or login APIs'); }
  close() {}
}
module.exports = { CodexBridge };
`);
  write(path.join(root, 'tools/literature-connector.js'), `'use strict';\n${controls}
class LiteratureConnector {
  constructor(root) { this.root = root; }
  get jobs() { const state = control(this.root); return new Map([['fixture', { status: state.scholar ? 'running' : 'completed', browserOpening: state.browserOpening === true }]]); }
}
module.exports = { LiteratureConnector };
`);
  write(path.join(root, 'tools/literature-flow.js'), `'use strict';\n${controls}
class LiteratureFlow {
  constructor(bridge) { this.root = bridge.root; }
  get active() { return new Map(control(this.root).literature ? [['fixture', {}]] : []); }
}
module.exports = { LiteratureFlow };
`);
  const port = await unusedPort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-4000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await ready(base, child, () => output);
    const get = async () => {
      const response = await fetch(base + '/api/literature/runtime', { headers: { Connection: 'close' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    const first = await get();
    checkShape(first);
    assert.equal(first.port, port);
    assert.equal(first.pid, child.pid);
    assert.equal(first.busy, false);
    assert.equal(first.restartRequired, false);
    assert.deepEqual(first.supportedSources, SOURCES);
    for (const mode of ['scholar', 'browserOpening', 'codex', 'source', 'pending', 'loginStarting', 'loginAttempt', 'literature']) {
      write(path.join(root, '.workbench/runtime-fixture-controls.json'), JSON.stringify({ [mode]: true }));
      const active = await get();
      assert.equal(active.busy, true, `${mode} work must prevent reporting an idle process`);
      assert.equal(active.restartRequired, false, 'Work status is not part of code version');
    }
    write(path.join(root, '.workbench/runtime-fixture-controls.json'), '{}');
    write(path.join(root, 'js/codex.js'), '// changed client\n');
    const staticUpdated = await get();
    assert.equal(staticUpdated.busy, false);
    assert.equal(staticUpdated.restartRequired, false);
    write(path.join(root, 'tools/literature-sources.json'), JSON.stringify({ sources: [{ key: 'google-scholar', state: 'executable' }] }));
    const outdated = await get();
    assert.equal(outdated.restartRequired, true);
    assert.equal(outdated.loadedFingerprint, first.loadedFingerprint);
    assert.deepEqual(outdated.supportedSources, SOURCES);
    const forbidden = await fetch(base + '/api/literature/runtime', { headers: { Origin: 'https://unrelated.example', Connection: 'close' } });
    assert.equal(forbidden.status, 403, 'Runtime endpoint keeps the existing origin guard');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  }
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-runtime-test-'));
  try {
    unitCases(path.join(temporary, 'unit'));
    await httpCases(path.join(temporary, 'http'));
    console.log('LITERATURE_RUNTIME_TESTS_PASS');
  } finally {
    const target = path.resolve(temporary);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanxu-runtime-test-')) throw new Error('Unexpected runtime test directory');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
