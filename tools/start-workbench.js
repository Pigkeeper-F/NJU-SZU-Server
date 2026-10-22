'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { workspaceIdFor, backendFingerprint } = require('./literature-runtime');

const ROOT = path.resolve(__dirname, '..');
const ID = /^[a-f0-9-]{36}$/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本地端口必须为1到65535之间的整数。');
  return port;
}

async function probeRuntime(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${validPort(port)}/api/literature/runtime`, {
      signal: AbortSignal.timeout(1500), redirect: 'error', headers: { Connection: 'close' }
    });
    const text = await response.text();
    if (text.length > 65536) return { listening: true, runtime: null, proxy: null };
    let data;
    try { data = JSON.parse(text); } catch (_) { return { listening: true, runtime: null, proxy: null }; }
    return { listening: true, runtime: response.ok ? data : null, proxy: data?.proxy || null };
  } catch (error) {
    // Only a refused connection proves the port is free. Timeouts or unknown
    // listeners must never authorize terminating another process.
    return { listening: error.cause?.code !== 'ECONNREFUSED', runtime: null };
  }
}

function hasPersistedWork(root) {
  const base = path.join(root, '.workbench');
  const dirs = dir => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && ID.test(entry.name)).map(entry => entry.name); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const running = file => {
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return !data || !data.status || data.status === 'running'; }
    catch (error) { return error.code !== 'ENOENT'; }
  };
  for (const id of dirs(path.join(base, 'literature'))) if (running(path.join(base, 'literature', id, 'job.json'))) return true;
  for (const session of dirs(base)) {
    const output = path.join(base, session, 'output');
    for (const id of dirs(output)) if (running(path.join(output, id, 'run-state.json'))) return true;
  }
  return false;
}

function commandOwnsScript(command, executable, root, relative, platform = process.platform) {
  const normalize = value => platform === 'win32' ? value.replace(/\//g, '\\').toLowerCase() : value;
  if (!/^(?:node|nodejs)(?:\.exe)?$/i.test(path.win32.basename(path.basename(String(executable || ''))))) return false;
  const args = String(command || '').match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  const unquote = value => value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single);
  return args.length >= 2 && normalize(unquote(args[1])) === normalize(path.join(path.resolve(root), relative));
}

function windowsProcessQuery(pid) {
  return '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; '
    + `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress)`;
}

function ownedProcess(pid, root, relative, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return false;
  let command = '', executable = '';
  if (platform === 'win32') {
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProcessQuery(pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status !== 0) return false;
    try { const value = JSON.parse(String(result.stdout || '')); command = value.CommandLine; executable = value.Name; } catch (_) { return false; }
  } else {
    const result = run('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) return false;
    command = String(result.stdout || '');
    const name = run('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    if (name.status !== 0) return false;
    executable = String(name.stdout || '').trim();
  }
  return commandOwnsScript(command, executable, root, relative, platform);
}

const ownedServerProcess = (pid, root) => ownedProcess(pid, root, 'server.js');
const ownedProxyProcess = (pid, root) => ownedProcess(pid, root, path.join('tools', 'workbench-proxy.js'));

function inspectService(state, port, workspaceId) {
  if (!state?.listening) return null;
  const runtime = state.runtime;
  const proxy = runtime?.proxy || state.proxy;
  const inRange = value => Number.isInteger(value) && value >= 1 && value <= 65535;
  const pid = value => Number.isSafeInteger(value) && value > 0;
  if (runtime?.workspaceId && runtime.workspaceId !== workspaceId) return { foreign: true };
  if (proxy?.workspaceId && proxy.workspaceId !== workspaceId) return { foreign: true };
  if (proxy && !(proxy.protocolVersion === 1 && proxy.workspaceId === workspaceId && pid(proxy.pid)
    && proxy.port === port && inRange(proxy.targetPort) && proxy.targetPort !== port)) return { unknown: true };
  if (runtime) {
    if (!(runtime.protocolVersion === 1 && runtime.workspaceId === workspaceId && pid(runtime.pid) && inRange(runtime.port)
      && typeof runtime.loadedFingerprint === 'string' && typeof runtime.restartRequired === 'boolean' && typeof runtime.busy === 'boolean')) return { unknown: true };
    if (proxy ? runtime.port !== proxy.targetPort : runtime.port !== port) return { unknown: true };
    return { runtime, proxy: proxy || null, corePort: runtime.port, observedPort: port };
  }
  return proxy ? { runtime: null, proxy, corePort: proxy.targetPort, observedPort: port } : { unknown: true };
}

async function planStartup({ root = ROOT, port, observed, verify = ownedServerProcess, verifyProxy = ownedProxyProcess, persistedBusy = hasPersistedWork, probe = probeRuntime }) {
  port = validPort(port);
  observed = observed || await probe(port);
  const url = `http://localhost:${port}/`;
  const workspaceId = workspaceIdFor(root);
  const states = new Map([[port, observed]]);
  for (const other of [8123, 18125].filter(value => value !== port)) states.set(other, await probe(other));
  const services = new Map([...states].map(([entryPort, state]) => [entryPort, inspectService(state, entryPort, workspaceId)]));
  const requested = services.get(port);
  if (requested?.unknown || requested?.foreign) {
    throw new Error(`端口${port}上已有无法核对版本或工作区的服务。请关闭该网址对应的旧启动窗口，再运行本启动器；原项目和任务会保留。`);
  }
  const known = [...services.values()].filter(value => value?.corePort);
  if (new Set(known.map(value => value.corePort)).size > 1) throw new Error('检测到同一工作区有两个独立后台。请保留运行任务，关闭闲置的旧启动窗口后再试；启动器不会自动终止它们。');
  let service = requested || known.find(value => value.runtime) || known[0];
  if (!service) {
    if ([...services.values()].some(value => value?.unknown)) throw new Error('另一个工作台端口上有无法核对的旧服务。请关闭对应旧启动窗口后重试，避免启动两个后台。');
    return { action: 'start', port, corePort: port, url };
  }
  const corePort = service.corePort;
  if (service.proxy) {
    const coreState = states.get(corePort) || await probe(corePort);
    const core = inspectService(coreState, corePort, workspaceId);
    if (!core) {
      if (!await verifyProxy(service.proxy.pid, root)) throw new Error('无法确认别名进程属于当前项目，请关闭对应启动窗口后重试。');
      return { action: 'restore', port, corePort, url, ...(observed.listening || port === corePort ? {} : { aliasPort: port }) };
    }
    if (core.unknown || core.foreign || core.proxy) throw new Error('别名指向的后台无法安全核对，请保留任务并关闭对应旧启动窗口后重试。');
    service = core;
  }
  const runtime = service.runtime;
  if (!runtime.restartRequired && runtime.loadedFingerprint === backendFingerprint(root)) {
    return { action: observed.listening ? 'reuse' : 'proxy', port, corePort, url, ...(observed.listening || port === corePort ? {} : { aliasPort: port }) };
  }
  if (runtime.busy || persistedBusy(root)) throw new Error('后台代码已更新，但仍有执行中的任务。请等待任务完成或暂停后，再运行启动器更新服务。');
  if ([...services.values()].some(value => value?.unknown || value?.runtime?.busy)) throw new Error('另一个工作台端口的运行状态无法排除，请等待任务完成或关闭旧启动窗口后更新。');
  if (!await verify(runtime.pid, root)) throw new Error('无法确认旧服务进程属于当前项目，请关闭对应的旧启动窗口后重试。');
  return { action: 'restart', port, corePort, url, pid: runtime.pid, ...(observed.listening || port === corePort ? {} : { aliasPort: port }) };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireStartupLock(root, { timeoutMs = 10000, pause = delay, isAlive = processAlive } = {}) {
  const base = path.join(path.resolve(root), '.workbench');
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, 'startup.lock'), recovery = path.join(base, 'startup-recovery.lock');
  const workspaceId = workspaceIdFor(root), token = randomUUID();
  const read = target => { try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { return null; } };
  const own = value => value?.workspaceId === workspaceId && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === 'string';
  const removeOwn = (target, ownerToken) => {
    if (read(target)?.token === ownerToken) { try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
  const create = target => {
    const handle = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify({ workspaceId, pid: process.pid, token, createdAt: new Date().toISOString() })); }
    catch (error) { fs.closeSync(handle); fs.unlinkSync(target); throw error; }
    fs.closeSync(handle);
  };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { create(file); return () => removeOwn(file, token); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = read(file);
    if (own(owner) && !isAlive(owner.pid)) {
      // A separate short-lived wx claim serializes stale-lock recovery. Otherwise
      // two recovery attempts could remove a newly acquired live startup lock.
      let recovering = false;
      try { create(recovery); recovering = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (recovering) {
        try {
          const current = read(file);
          if (own(current) && !isAlive(current.pid)) fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { removeOwn(recovery, token); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error('已有启动操作或无法核对的启动锁，请稍后重试；不要同时打开多个启动窗口。');
    await pause(100);
  }
}

async function executeStartup(plan, { root = ROOT, probe = probeRuntime, verify = ownedServerProcess,
  persistedBusy = hasPersistedWork, terminate = pid => process.kill(pid, 'SIGTERM'), spawnProcess = spawn, pause = delay } = {}) {
  const children = [], workspaceId = workspaceIdFor(root);
  const currentCore = state => {
    const value = inspectService(state, plan.corePort, workspaceId);
    return value?.runtime && !value.proxy && !value.unknown && !value.foreign ? value.runtime : null;
  };
  const upToDate = runtime => runtime && !runtime.restartRequired && runtime.loadedFingerprint === backendFingerprint(root);
  const start = async (kind, port, targetPort) => {
    const script = path.join(root, kind === 'core' ? 'server.js' : 'tools/workbench-proxy.js');
    const args = kind === 'core' ? [script] : [script, '--port', String(port), '--target-port', String(targetPort)];
    const child = spawnProcess(process.execPath, args, { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'inherit', windowsHide: true });
    const record = { child, kind, ready: false, error: null }; children.push(record);
    child.once('error', error => { record.error = error; });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (record.error || child.exitCode !== null) break;
      const state = await probe(port);
      const runtime = state.runtime;
      const identity = kind === 'core' ? runtime?.pid === child.pid && !runtime?.proxy
        : runtime?.proxy?.pid === child.pid && runtime.proxy.port === port && runtime.proxy.targetPort === targetPort;
      if (runtime && identity && runtime.workspaceId === workspaceId && runtime.port === plan.corePort && upToDate(runtime)) { record.ready = true; return; }
      await pause(100);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new Error(kind === 'core' ? '新版后台未能就绪，请查看启动窗口；原任务保留。' : '别名网址未能就绪；已有后台和任务保留，请重试启动器。');
  };
  try {
    if (plan.action === 'reuse') return { ...plan, children };
    if (plan.action === 'restart') {
      const runtime = currentCore(await probe(plan.corePort));
      if (!runtime || runtime.pid !== plan.pid || runtime.busy || persistedBusy(root) || !await verify(plan.pid, root)) {
        throw new Error('后台运行状态已变化，已取消重启；请等待任务完成后重试。');
      }
      for (const peer of [8123, 18125].filter(value => value !== plan.corePort)) {
        const value = inspectService(await probe(peer), peer, workspaceId);
        if (value?.unknown || value?.runtime?.busy) throw new Error('其他端口仍有任务或无法核对，已取消重启。');
      }
      terminate(plan.pid);
      let free = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (!(await probe(plan.corePort)).listening) { free = true; break; }
        await pause(100);
      }
      if (!free) throw new Error('旧后台尚未退出；别名与已有任务保留，请稍后重试。');
    }
    if (['start', 'restart', 'restore'].includes(plan.action)) {
      if ((await probe(plan.corePort)).listening) throw new Error('后台端口状态已变化，未启动第二个后台；请重新运行启动器。');
      await start('core', plan.corePort);
    }
    if (plan.action === 'proxy' || plan.aliasPort) {
      if (!upToDate(currentCore(await probe(plan.corePort)))) throw new Error('主后台无法核对，未创建别名，请重新运行启动器。');
      const aliasPort = plan.aliasPort || plan.port;
      const aliasState = await probe(aliasPort);
      if (aliasState.listening) {
        const existing = inspectService(aliasState, aliasPort, workspaceId);
        if (!existing?.proxy || existing.corePort !== plan.corePort || !upToDate(existing.runtime)) throw new Error('别名端口已被其他服务占用，现有进程未作改动。');
      } else await start('proxy', aliasPort, plan.corePort);
    }
    return { ...plan, children };
  } catch (error) {
    // A backend that became ready may already have accepted browser work. Never
    // stop it merely because a later alias could not bind.
    for (const record of children) if (record.ready) record.child.unref?.();
    throw error;
  }
}

function openUrl(url) {
  let command, args;
  if (process.platform === 'win32') { command = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; }
  else if (process.platform === 'darwin') { command = 'open'; args = [url]; }
  else { command = 'xdg-open'; args = [url]; }
  const opener = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
  opener.on('error', () => console.log('请在浏览器打开：' + url)); opener.unref();
}

async function main(args = process.argv.slice(2)) {
  const at = args.indexOf('--port');
  const port = validPort(at >= 0 ? args[at + 1] : process.env.PORT || 8123);
  const release = await acquireStartupLock(ROOT);
  let result;
  try { result = await executeStartup(await planStartup({ root: ROOT, port }), { root: ROOT }); }
  finally { release(); }
  console.log((result.action === 'reuse' ? '复用已运行的工作台：' : '工作台已就绪：') + result.url);
  openUrl(result.url);
  if (!result.children.length) return;
  const stop = () => { for (const { child } of result.children) if (child.exitCode === null) child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const codes = await Promise.all(result.children.map(({ child }) => child.exitCode !== null || child.signalCode
    ? Promise.resolve(child.exitCode)
    : new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(1)); })));
  if (codes.some(Boolean)) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validPort, probeRuntime, hasPersistedWork, commandOwnsScript, ownedServerProcess,
  ownedProxyProcess, ownedProcess, windowsProcessQuery, inspectService, planStartup, acquireStartupLock, executeStartup };
