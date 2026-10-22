'use strict';

// A second localhost origin is only an alias for the same workbench executor.
// This module never loads server.js, the task connector, or local credentials.
const http = require('node:http');
const path = require('node:path');
const { workspaceIdFor } = require('./literature-runtime');

const RUNTIME_PATH = '/api/literature/runtime';
const MAX_RUNTIME_BYTES = 64 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function validPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('本地代理端口必须为1到65535之间的整数。');
  return value;
}

function canonicalRuntime(value, workspaceId, targetPort) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.protocolVersion === 1 && value.workspaceId === workspaceId && value.port === targetPort
    && !Object.hasOwn(value, 'proxy');
}

function readTargetRuntime(targetPort) {
  validPort(targetPort);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port: targetPort,
      path: RUNTIME_PATH, headers: { Host: `127.0.0.1:${targetPort}`, Accept: 'application/json', 'Cache-Control': 'no-cache' } }, response => {
      let size = 0;
      const chunks = [];
      if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > MAX_RUNTIME_BYTES) {
        response.destroy(); finish(new Error('主后台运行信息无效')); return;
      }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RUNTIME_BYTES) { response.destroy(); finish(new Error('主后台运行信息过大')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { finish(new Error('主后台运行信息无效')); }
      });
      response.on('error', () => finish(new Error('主后台运行信息读取失败')));
      response.on('aborted', () => finish(new Error('主后台运行信息中断')));
    });
    request.setTimeout(1500, () => { request.destroy(); finish(new Error('主后台运行信息超时')); });
    request.on('error', () => finish(new Error('主后台暂不可用')));
  });
}

function allowedHost(value, port) {
  if (typeof value !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):([0-9]+)$/i.exec(value);
  return !!match && Number(match[2]) === port;
}

function allowedOrigin(value, port) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`].includes(value);
}

function publicPath(value) {
  // Request options use this path verbatim and a fixed hostname. Reject proxy
  // absolute-form URLs instead of allowing a caller-selected remote target.
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !/[\r\n\\]/.test(value);
}

function forwardedHeaders(headers) {
  const denied = new Set(HOP_HEADERS);
  for (const name of String(headers.connection || '').split(',')) if (name.trim()) denied.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !denied.has(name.toLowerCase())));
}

function aliasLocation(value, aliasHost, targetPort) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && !url.username && !url.password
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && Number(url.port || 80) === targetPort) return `http://${aliasHost}${url.pathname}${url.search}${url.hash}`;
  } catch (_) { /* Relative redirects already remain on the alias origin. */ }
  return value;
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length, 'Cache-Control': 'no-store' });
  response.end(body);
}

function createWorkbenchProxy({ root, port, targetPort, probeRuntime = readTargetRuntime }) {
  validPort(port); validPort(targetPort);
  if (port === targetPort) throw new Error('别名端口不能与主后台端口相同。');
  if (typeof root !== 'string' || !root || typeof probeRuntime !== 'function') throw new Error('本地代理配置无效。');
  const workspaceId = workspaceIdFor(root);
  const proxy = Object.freeze({ protocolVersion: 1, workspaceId, pid: process.pid, port, targetPort });
  let checking = null;
  function checkTarget() {
    // Concurrent asset loads may share an in-flight check. Completed snapshots
    // are never cached, so a replaced/closed target cannot silently be reused.
    if (!checking) {
      checking = Promise.resolve().then(() => probeRuntime(targetPort)).then(value => {
        if (!canonicalRuntime(value, workspaceId, targetPort)) throw new Error('主后台运行信息不匹配');
        return value;
      }).finally(() => { checking = null; });
    }
    return checking;
  }
  const server = http.createServer(async (request, response) => {
    // Check the incoming origin before probing or forwarding any local service.
    if (!allowedHost(request.headers.host, port) || !allowedOrigin(request.headers.origin, port)) {
      sendJson(response, 403, { error: '只允许从当前本机工作台访问。' }); return;
    }
    if (!publicPath(request.url) || request.method === 'CONNECT') {
      sendJson(response, 400, { error: '本地代理请求地址无效。' }); return;
    }
    const runtimeRequest = request.method === 'GET' && request.url.split('?')[0] === RUNTIME_PATH;
    let runtime;
    try { runtime = await checkTarget(); }
    catch (_) {
      sendJson(response, runtimeRequest ? 503 : 502,
        { error: '主后台暂不可用，请重新运行启动器', ...(runtimeRequest ? { proxy } : {}) }); return;
    }
    if (request.aborted || response.destroyed) return;
    if (runtimeRequest) { sendJson(response, 200, { ...runtime, proxy }); return; }
    const headers = forwardedHeaders(request.headers);
    // The upstream workbench redirects static 127.0.0.1 Hosts to localhost.
    // Send its canonical Host while retaining the caller's alias origin.
    headers.host = `localhost:${targetPort}`;
    if (request.headers.origin) headers.origin = `http://localhost:${targetPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: request.url,
      method: request.method, headers }, incoming => {
      const outgoing = forwardedHeaders(incoming.headers);
      if (outgoing.location) outgoing.location = aliasLocation(outgoing.location, request.headers.host, targetPort);
      response.writeHead(incoming.statusCode || 502, outgoing);
      incoming.on('error', () => response.destroy());
      incoming.on('aborted', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) sendJson(response, 502, { error: '主后台连接中断，请重新运行启动器' });
      else response.destroy();
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}

function parseArguments(args) {
  const found = {};
  if (!Array.isArray(args) || args.length !== 4) throw new Error('用法：node workbench-proxy.js --port <别名端口> --target-port <主后台端口>');
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--port', '--target-port'].includes(name) || Object.hasOwn(found, name) || !/^[0-9]+$/.test(args[index + 1])) throw new Error('本地代理参数无效。');
    found[name] = validPort(Number(args[index + 1]));
  }
  if (found['--port'] === found['--target-port']) throw new Error('别名端口不能与主后台端口相同。');
  return { port: found['--port'], targetPort: found['--target-port'] };
}

async function main(args = process.argv.slice(2)) {
  const { port, targetPort } = parseArguments(args);
  const root = path.resolve(__dirname, '..');
  const runtime = await readTargetRuntime(targetPort);
  if (!canonicalRuntime(runtime, workspaceIdFor(root), targetPort)) throw new Error('主后台运行信息不匹配，不能启动别名代理。');
  const server = createWorkbenchProxy({ root, port, targetPort });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`工作台别名已连接：http://localhost:${port}/`);
  return server;
}

if (require.main === module) main().catch(() => { console.error('无法连接当前项目的主后台，请重新运行启动器。'); process.exitCode = 1; });

module.exports = { createWorkbenchProxy, canonicalRuntime, readTargetRuntime, parseArguments, main };
