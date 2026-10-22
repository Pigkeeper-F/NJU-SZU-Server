'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createWorkbenchProxy, canonicalRuntime, parseArguments } = require('./workbench-proxy');
const { workspaceIdFor } = require('./literature-runtime');

const root = path.resolve(__dirname, '..', 'proxy-test-workspace');
const workspaceId = workspaceIdFor(root);
const binary = Buffer.from([0, 255, 128, 10, 13, 65, 66, 0]);

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const allocator = http.createServer();
  const port = await listen(allocator);
  await close(allocator);
  return port;
}

function close(server) {
  return new Promise(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(resolve);
    server.closeIdleConnections?.();
  });
}

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route,
      headers: { Host: `localhost:${port}`, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  let runtimeMode = 'valid', runtimeReads = 0, applicationRequests = 0, sseFinished = false;
  const applicationLog = [];
  let targetPort;
  const target = http.createServer((req, res) => {
    if (req.url === '/api/literature/runtime') {
      runtimeReads++;
      const runtime = { protocolVersion: 1, workspaceId, pid: process.pid, port: targetPort,
        instanceId: 'single-executor', busy: false, generation: runtimeReads };
      if (runtimeMode === 'wrong-workspace') runtime.workspaceId = 'different-workspace';
      if (runtimeMode === 'wrong-port') runtime.port = targetPort + 1;
      if (runtimeMode === 'old-protocol') runtime.protocolVersion = 2;
      if (runtimeMode === 'proxy-chain') runtime.proxy = { targetPort: targetPort + 1 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(runtimeMode === 'invalid-json' ? '{broken' : JSON.stringify(runtime));
      return;
    }
    applicationRequests++;
    applicationLog.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/') {
      // Mirror the real workbench static redirect: exposing the target Host
      // as 127.0.0.1 would silently move the page and its localStorage origin.
      if (req.headers.host.startsWith('127.0.0.1:')) {
        res.writeHead(302, { Location: `http://localhost:${targetPort}/` }); res.end();
      } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>same executor</title>'); }
      return;
    }
    if (req.url === '/download') {
      res.writeHead(206, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="records.bin"',
        'Content-Range': 'bytes 0-7/8', 'Content-Length': binary.length, 'X-Executor': 'single' });
      res.end(binary); return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => { sseFinished = true; res.end('data: second\n\n'); }, 100);
      return;
    }
    if (req.url === '/redirect-local') {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/index.html?x=1#pane` }); res.end(); return;
    }
    if (req.url === '/redirect-official') {
      res.writeHead(302, { Location: 'https://access.clarivate.com/login?flow=official' }); res.end(); return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(202, { 'Content-Type': 'application/json', 'X-Executor': 'single' });
      res.end(JSON.stringify({ executor: 'single', method: req.method, url: req.url,
        host: req.headers.host, origin: req.headers.origin, workbench: req.headers['x-workbench'],
        body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  const aliasPort = await unusedPort();
  let proxy;
  try {
    targetPort = await listen(target);
    proxy = createWorkbenchProxy({ root, port: aliasPort, targetPort });
    assert.equal(proxy.listening, false, 'factory must not listen');
    assert.equal(runtimeReads, 0, 'factory must not probe or load an executor as a side effect');
    await listen(proxy, aliasPort);

    const metadata = { protocolVersion: 1, workspaceId, pid: process.pid, port: aliasPort, targetPort };
    let reply = await request(aliasPort, '/api/literature/runtime');
    assert.equal(reply.status, 200);
    let data = JSON.parse(reply.text);
    assert.deepEqual(data.proxy, metadata);
    assert.equal(data.instanceId, 'single-executor');
    assert.equal(data.port, targetPort, 'runtime still identifies the sole real executor');
    assert.equal(reply.headers['cache-control'], 'no-store');
    const generation = data.generation;
    data = JSON.parse((await request(aliasPort, '/api/literature/runtime')).text);
    assert.ok(data.generation > generation, 'runtime responses must never be cached');

    reply = await request(aliasPort, '/', { headers: { Host: `127.0.0.1:${aliasPort}` } });
    assert.equal(reply.status, 200, 'static page must not redirect to canonical target port');
    assert.equal(reply.headers.location, undefined);
    assert.match(reply.text, /same executor/);

    const body = JSON.stringify({ id: 'fixture-task', text: '原任务继续' });
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      reply = await request(aliasPort, '/api/literature/advance?until=discover', { method: 'POST',
        headers: { Host: `${host}:${aliasPort}`, Origin: `http://${host}:${aliasPort}`,
          'X-Workbench': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
      assert.equal(reply.status, 202);
      data = JSON.parse(reply.text);
      assert.equal(data.executor, 'single');
      assert.equal(data.host, `localhost:${targetPort}`);
      assert.equal(data.origin, `http://localhost:${targetPort}`);
      assert.equal(data.workbench, '1');
      assert.equal(data.method, 'POST');
      assert.equal(data.url, '/api/literature/advance?until=discover');
      assert.equal(data.body, body);
    }
    reply = await request(aliasPort, '/api/guard', { method: 'POST', body: 'plain' });
    assert.equal(JSON.parse(reply.text).workbench, undefined, 'alias must not invent X-Workbench authorization');

    const beforeGuard = { runtimeReads, applicationRequests };
    for (const headers of [
      { Host: 'external.example:' + aliasPort },
      { Host: 'localhost:' + targetPort },
      { Origin: 'https://evil.example' },
      { Origin: `http://localhost:${targetPort}` },
      { Origin: `http://localhost:${aliasPort}/path` },
      { Origin: 'null' }
    ]) {
      reply = await request(aliasPort, '/api/literature/search', { method: 'POST', headers, body: '{}' });
      assert.equal(reply.status, 403, JSON.stringify(headers));
    }
    for (const route of ['https://remote.example/api', '//remote.example/api', '/bad\\path']) {
      reply = await request(aliasPort, route);
      assert.equal(reply.status, 400);
    }
    assert.deepEqual({ runtimeReads, applicationRequests }, beforeGuard, 'blocked requests must not probe or reach the executor');

    reply = await request(aliasPort, '/download');
    assert.equal(reply.status, 206);
    assert.deepEqual(reply.bytes, binary);
    assert.equal(reply.headers['content-disposition'], 'attachment; filename="records.bin"');
    assert.equal(reply.headers['content-range'], 'bytes 0-7/8');
    assert.equal(reply.headers['x-executor'], 'single');

    await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: aliasPort, path: '/stream',
        headers: { Host: `localhost:${aliasPort}` } }, res => {
        const chunks = [];
        res.on('data', chunk => {
          if (!chunks.length) {
            try { assert.equal(sseFinished, false, 'SSE must reach the browser before upstream ends'); }
            catch (error) { reject(error); }
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try { assert.equal(Buffer.concat(chunks).toString(), 'data: first\n\ndata: second\n\n'); resolve(); }
          catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    reply = await request(aliasPort, '/redirect-local', { headers: { Host: `127.0.0.1:${aliasPort}` } });
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.location, `http://127.0.0.1:${aliasPort}/index.html?x=1#pane`);
    reply = await request(aliasPort, '/redirect-official');
    assert.equal(reply.headers.location, 'https://access.clarivate.com/login?flow=official');

    for (const mode of ['wrong-workspace', 'wrong-port', 'old-protocol', 'proxy-chain', 'invalid-json']) {
      runtimeMode = mode;
      const before = applicationRequests;
      reply = await request(aliasPort, '/api/literature/runtime');
      assert.equal(reply.status, 503, mode);
      assert.deepEqual(JSON.parse(reply.text).proxy, metadata);
      assert.equal(JSON.parse(reply.text).error, '主后台暂不可用，请重新运行启动器');
      reply = await request(aliasPort, '/api/literature/search', { method: 'POST', headers: { 'X-Workbench': '1' }, body: '{}' });
      assert.equal(reply.status, 502, mode);
      assert.equal(applicationRequests, before, 'unverified replacement target must not receive data');
    }
    runtimeMode = 'valid';
    await close(target);
    reply = await request(aliasPort, '/api/literature/runtime');
    assert.equal(reply.status, 503);
    assert.deepEqual(JSON.parse(reply.text).proxy, metadata);
    reply = await request(aliasPort, '/');
    assert.equal(reply.status, 502);

    for (const ports of [{ port: aliasPort, targetPort: aliasPort }, { port: 0, targetPort },
      { port: aliasPort, targetPort: 65536 }, { port: aliasPort, targetPort: 'https://remote.example' }]) {
      assert.throws(() => createWorkbenchProxy({ root, ...ports }));
    }
    assert.deepEqual(parseArguments(['--port', '18125', '--target-port', '8123']), { port: 18125, targetPort: 8123 });
    for (const args of [[], ['--port', '18125', '--target-url', 'https://remote.example'],
      ['--port', '8123', '--target-port', '8123'], ['--port', '18125', '--port', '8123']]) assert.throws(() => parseArguments(args));
    assert.equal(canonicalRuntime({ protocolVersion: 1, workspaceId, port: targetPort, proxy: null }, workspaceId, targetPort), false);
    assert.ok(applicationLog.every(item => item.headers.host === `localhost:${targetPort}`));
    console.log('WORKBENCH_PROXY_TESTS_PASS');
  } finally {
    if (proxy) await close(proxy);
    await close(target);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
