'use strict';

// All services, spawns and terminations below are mocks in isolated directories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { workspaceIdFor, backendFingerprint } = require('./literature-runtime');
const { validPort, probeRuntime, hasPersistedWork, commandOwnsScript, planStartup, acquireStartupLock, executeStartup } = require('./start-workbench');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const free = () => ({ listening: false, runtime: null });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pause = () => new Promise(resolve => setTimeout(resolve, 3));

function runtime(root, port, extra = {}) {
  return { protocolVersion: 1, workspaceId: workspaceIdFor(root), pid: 45001, port,
    instanceId: ID, loadedFingerprint: backendFingerprint(root), restartRequired: false, busy: false, ...extra };
}

function proxy(root, port, targetPort) {
  return { protocolVersion: 1, workspaceId: workspaceIdFor(root), pid: 45002, port, targetPort };
}

function coreState(root, port, extra) { return { listening: true, runtime: runtime(root, port, extra) }; }
function aliasState(root, port, core) {
  const metadata = proxy(root, port, core.port);
  return { listening: true, runtime: { ...core, proxy: metadata }, proxy: metadata };
}

function planner(root, states, port, extra = {}) {
  return planStartup({ root, port, observed: states[port] || free(), probe: async value => states[value] || free(),
    persistedBusy: () => false, verify: async () => true, verifyProxy: async () => true, ...extra });
}

async function planTests(root) {
  assert.equal(validPort('18125'), 18125);
  for (const port of [0, -1, 65536, 'all', 1.5]) assert.throws(() => validPort(port), /端口/);
  const basic = await planner(root, {}, 18125);
  assert.equal(basic.action, 'start'); assert.equal(basic.corePort, 18125);
  const current = runtime(root, 18125);
  let states = { 18125: { listening: true, runtime: current } };
  assert.equal((await planner(root, states, 18125)).action, 'reuse');
  const alias = await planner(root, states, 8123);
  assert.equal(alias.action, 'proxy'); assert.equal(alias.corePort, 18125); assert.equal(alias.aliasPort, 8123);
  assert.equal(alias.url, 'http://localhost:8123/', 'Alias keeps the browser origin and its localStorage');
  states[18125].runtime.busy = true;
  assert.equal((await planner(root, states, 8123)).action, 'proxy', 'An active core may gain an alias without being restarted');
  states[18125].runtime.busy = false;
  states[8123] = aliasState(root, 8123, current);
  assert.equal((await planner(root, states, 8123)).action, 'reuse');

  const stale = runtime(root, 18125, { loadedFingerprint: 'old-code', restartRequired: true });
  states = { 18125: { listening: true, runtime: stale }, 8123: aliasState(root, 8123, stale) };
  const restart = await planner(root, states, 8123);
  assert.equal(restart.action, 'restart'); assert.equal(restart.pid, stale.pid); assert.equal(restart.corePort, 18125);
  assert.equal(restart.aliasPort, undefined, 'Existing alias stays running while only the core is restarted');
  const withNewAlias = await planner(root, { 18125: states[18125] }, 8123);
  assert.equal(withNewAlias.action, 'restart'); assert.equal(withNewAlias.aliasPort, 8123);
  await assert.rejects(planner(root, states, 8123, { verify: async () => false }), /无法确认旧服务进程/);
  await assert.rejects(planner(root, states, 8123, { persistedBusy: () => true }), /执行中的任务/);
  await assert.rejects(planner(root, { 18125: coreState(root, 18125, { restartRequired: true, busy: true }) }, 18125), /执行中的任务/);

  const metadata = proxy(root, 8123, 18125);
  states = { 8123: { listening: true, runtime: null, proxy: metadata } };
  const restore = await planner(root, states, 8123);
  assert.equal(restore.action, 'restore'); assert.equal(restore.corePort, 18125); assert.equal(restore.aliasPort, undefined);
  const restoreCoreOrigin = await planner(root, states, 18125);
  assert.equal(restoreCoreOrigin.action, 'restore'); assert.equal(restoreCoreOrigin.aliasPort, undefined, 'Do not proxy the restored core port onto itself');
  await assert.rejects(planner(root, states, 8123, { verifyProxy: async () => false }), /无法确认别名进程/);
  states[18125] = { listening: true, runtime: null };
  await assert.rejects(planner(root, states, 8123), /后台无法安全核对/);

  await assert.rejects(planner(root, { 8123: { listening: true, runtime: null } }, 8123), /无法核对版本或工作区/);
  await assert.rejects(planner(root, { 8123: { listening: true, runtime: null } }, 18125), /无法核对的旧服务/);
  await assert.rejects(planner(root, { 8123: coreState(root, 8123, { workspaceId: 'other-workspace' }) }, 8123), /无法核对版本或工作区/);
  assert.equal((await planner(root, { 8123: coreState(root, 8123, { workspaceId: 'other-workspace' }) }, 18125)).action, 'start');
  await assert.rejects(planner(root, { 8123: coreState(root, 8123), 18125: coreState(root, 18125, { pid: 45003 }) }, 8123), /两个独立后台/);
}

function effects(root, initial = {}) {
  const states = { ...initial }, spawned = [], killed = [];
  let nextPid = 46000;
  const options = {
    root, probe: async port => states[port] || free(), pause, persistedBusy: () => false, verify: async () => true,
    terminate(pid) {
      killed.push(pid);
      for (const [port, state] of Object.entries(states)) {
        if (state.runtime?.pid !== pid) continue;
        states[port] = state.runtime.proxy ? { listening: true, runtime: null, proxy: state.runtime.proxy } : free();
      }
    },
    spawnProcess(executable, args, config) {
      const child = new EventEmitter(); child.pid = ++nextPid; child.exitCode = null; child.signalCode = null;
      child.kill = () => { killed.push(child.pid); child.exitCode = 0; child.emit('exit', 0); };
      child.unref = () => {};
      const port = Number(config.env.PORT), isProxy = args[0].endsWith('workbench-proxy.js');
      spawned.push({ executable, args, config, child, kind: isProxy ? 'proxy' : 'core' });
      assert.equal(path.isAbsolute(args[0]), true, 'Launch exact absolute script paths');
      assert.equal(config.cwd, root); assert.equal(config.windowsHide, true);
      if (!isProxy) {
        const value = runtime(root, port, { pid: child.pid });
        states[port] = { listening: true, runtime: value };
        for (const [aliasPort, state] of Object.entries(states)) {
          const metadata = state.runtime?.proxy || state.proxy;
          if (metadata?.targetPort === port) states[aliasPort] = { listening: true, runtime: { ...value, proxy: metadata }, proxy: metadata };
        }
      } else {
        const targetPort = Number(args[args.indexOf('--target-port') + 1]);
        const metadata = { ...proxy(root, port, targetPort), pid: child.pid };
        states[port] = { listening: true, runtime: { ...states[targetPort].runtime, proxy: metadata }, proxy: metadata };
      }
      return child;
    }
  };
  return { states, spawned, killed, options };
}

async function effectTests(root) {
  let fixture = effects(root);
  await executeStartup(await planner(root, fixture.states, 18125), fixture.options);
  await executeStartup(await planner(root, fixture.states, 8123), fixture.options);
  assert.deepEqual(fixture.spawned.map(value => value.kind), ['core', 'proxy']);
  assert.equal(fixture.states[8123].runtime.pid, fixture.states[18125].runtime.pid, 'Both origins share one actual executor');
  assert.deepEqual(fixture.killed, []);
  await executeStartup(await planner(root, fixture.states, 8123), fixture.options);
  assert.equal(fixture.spawned.length, 2, 'Repeated start reuses both origins');

  const stale = runtime(root, 18125, { pid: 47001, restartRequired: true, loadedFingerprint: 'old' });
  fixture = effects(root, { 18125: { listening: true, runtime: stale }, 8123: aliasState(root, 8123, stale) });
  const aliasPid = fixture.states[8123].proxy.pid;
  await executeStartup(await planner(root, fixture.states, 8123), fixture.options);
  assert.deepEqual(fixture.killed, [47001], 'Restart only the verified core, never the alias');
  assert.deepEqual(fixture.spawned.map(value => value.kind), ['core']);
  assert.equal(fixture.states[8123].proxy.pid, aliasPid);
  assert.equal(fixture.states[8123].runtime.pid, fixture.states[18125].runtime.pid);

  fixture = effects(root, { 8123: { listening: true, runtime: null, proxy: proxy(root, 8123, 18125) } });
  await executeStartup(await planner(root, fixture.states, 8123), fixture.options);
  assert.deepEqual(fixture.killed, []);
  assert.deepEqual(fixture.spawned.map(value => value.kind), ['core'], 'Restore a dead core behind the existing alias');

  fixture = effects(root, { 18125: { listening: true, runtime: stale } });
  const plan = await planner(root, fixture.states, 18125);
  fixture.states[18125].runtime.busy = true;
  await assert.rejects(executeStartup(plan, fixture.options), /运行状态已变化/);
  assert.deepEqual(fixture.killed, []); assert.deepEqual(fixture.spawned, [], 'A newly started job cancels restart');
}

async function lockTests(root) {
  const fixture = effects(root);
  const launch = async port => {
    const release = await acquireStartupLock(root, { pause });
    try { return await executeStartup(await planner(root, fixture.states, port), fixture.options); }
    finally { release(); }
  };
  await Promise.all([launch(8123), launch(18125)]);
  assert.equal(fixture.spawned.filter(value => value.kind === 'core').length, 1, 'Simultaneous launchers must not start two connectors');
  assert.equal(fixture.spawned.filter(value => value.kind === 'proxy').length, 1);
  assert.equal(fs.existsSync(path.join(root, '.workbench/startup.lock')), false);

  const file = path.join(root, '.workbench/startup.lock');
  write(file, JSON.stringify({ workspaceId: workspaceIdFor(root), pid: 99999999, token: 'stale-owner' }));
  const release = await acquireStartupLock(root, { pause, isAlive: pid => pid === process.pid });
  const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(fs.existsSync(path.join(root, '.workbench/startup-recovery.lock')), false);
  await assert.rejects(acquireStartupLock(root, { timeoutMs: 0, pause }), /已有启动操作/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, owner.token, 'A second launcher cannot remove a live owner lock');
  release();
  write(file, 'unknown-lock');
  await assert.rejects(acquireStartupLock(root, { timeoutMs: 0, pause }), /无法核对的启动锁/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unknown-lock');
  fs.unlinkSync(file);
}

async function probeTests(root) {
  const original = global.fetch;
  try {
    const metadata = proxy(root, 8123, 18125);
    global.fetch = async () => new Response(JSON.stringify({ error: 'core down', proxy: metadata }), { status: 503 });
    const unavailable = await probeRuntime(8123);
    assert.equal(unavailable.listening, true); assert.equal(unavailable.runtime, null); assert.deepEqual(unavailable.proxy, metadata);
    global.fetch = async () => new Response('<html>old workbench</html>', { status: 404 });
    assert.equal((await probeRuntime(8123)).runtime, null);
    global.fetch = async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); };
    assert.equal((await probeRuntime(8123)).listening, false);
    global.fetch = async () => { throw Object.assign(new Error('timeout'), { cause: { code: 'ETIMEDOUT' } }); };
    assert.equal((await probeRuntime(8123)).listening, true, 'A timeout cannot prove a port free');
  } finally { global.fetch = original; }
}

function persistedAndOwnershipTests(root) {
  assert.equal(hasPersistedWork(root), false);
  const job = path.join(root, '.workbench/literature', ID, 'job.json');
  write(job, JSON.stringify({ status: 'running' })); assert.equal(hasPersistedWork(root), true);
  write(job, JSON.stringify({ status: 'needs_attention' })); assert.equal(hasPersistedWork(root), false);
  write(job, 'malformed'); assert.equal(hasPersistedWork(root), true);
  write(job, JSON.stringify({ status: 'completed' }));
  const state = path.join(root, '.workbench', ID, 'output', ID, 'run-state.json');
  write(state, JSON.stringify({ status: 'running' })); assert.equal(hasPersistedWork(root), true);
  write(state, JSON.stringify({ status: 'waiting' })); assert.equal(hasPersistedWork(root), false);
  const script = path.join(root, 'server.js');
  assert.equal(commandOwnsScript(`"node.exe" "${script}"`, 'node.exe', root, 'server.js'), true);
  assert.equal(commandOwnsScript('node.exe server.js', 'node.exe', root, 'server.js'), false);
  assert.equal(commandOwnsScript(`node.exe "${script}.bak"`, 'node.exe', root, 'server.js'), false);
  assert.equal(commandOwnsScript(`node.exe -e "require('${script}')"`, 'node.exe', root, 'server.js'), false);
  assert.equal(commandOwnsScript(`powershell.exe "${script}"`, 'powershell.exe', root, 'server.js'), false);
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-startup-test-'));
  try {
    await planTests(temporary);
    await effectTests(temporary);
    await lockTests(temporary);
    await probeTests(temporary);
    persistedAndOwnershipTests(temporary);
    console.log('START_WORKBENCH_TESTS_PASS');
  } finally {
    const target = path.resolve(temporary);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanxu-startup-test-')) throw new Error('Unexpected startup test directory');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
