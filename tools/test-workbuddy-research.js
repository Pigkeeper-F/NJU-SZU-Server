'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { composeWorkBuddy } = require('./workbuddy-research');

const tasks = 'https://www.workbuddy.cn/openapi/v2/tasks';
const accessToken = 'test-oauth-only';
const question = [{ role: 'user', content: '测试研究问题' }];
const encoder = new TextEncoder();

function fixture(mode = 'success') {
  const records = new Map();
  const calls = [];
  let prompted;
  const promptSeen = new Promise(resolve => { prompted = resolve; });
  async function fetchImpl(url, init) {
    assert.equal(init.redirect, 'error');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (url === tasks) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer ' + accessToken);
      assert.ok(!body.prompt.includes(question[0].content));
      if (mode === 'unauthorized') return new Response('unsafe diagnostic', { status: 401 });
      const id = String(records.size + 1);
      const link = mode === 'bad-host' ? 'https://example.org/acp' : 'https://acp.workbuddy.cn/sessions/' + id;
      const task = { task_id: id, status: 'working', link, token: 'test-ticket-' + id };
      records.set(id, { task, closed: false, calls: [] });
      return Response.json(mode === 'creating' ? { task_id: id, status: 'CREATING' } : task, { status: 201 });
    }
    if (url.startsWith(tasks + '/')) {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, 'Bearer ' + accessToken);
      return Response.json(records.get(url.split('/').pop()).task);
    }
    const id = url.split('/').pop();
    const record = records.get(id);
    assert.equal(url, record.task.link);
    assert.equal(init.headers.Authorization, 'Bearer ' + record.task.token);
    if (init.method === 'GET') {
      const stream = new ReadableStream({
        start(controller) { record.controller = controller; },
        cancel() { record.closed = true; }
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Acp-Connection-Id': 'connection-' + id } });
    }
    assert.equal(init.headers['Acp-Connection-Id'], 'connection-' + id);
    record.calls.push(body);
    function send(message) {
      const bytes = encoder.encode(': ping\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', ...message }) + '\r\n\r\n');
      const split = Math.ceil(bytes.length / 2);
      record.controller.enqueue(bytes.subarray(0, split));
      record.controller.enqueue(bytes.subarray(split));
    }
    function chunk(sessionId, messageId, text, sessionUpdate = 'agent_message_chunk') {
      send({ method: 'session/update', params: { sessionId, update: { messageId, sessionUpdate, content: { type: 'text', text } } } });
    }
    if (body.method === 'initialize') {
      assert.deepEqual(body.params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
      assert.equal(body.params.clientCapabilities.terminal, false);
      send({ id: body.id, result: { protocolVersion: 1 } });
    } else if (body.method === 'session/load') {
      assert.deepEqual(body.params, { sessionId: id, cwd: '/workspace', mcpServers: [] });
      chunk(id, 'bootstrap', '历史记录');
      send({ id: body.id, result: {} });
    } else if (body.method === 'session/prompt') {
      prompted();
      assert.equal(body.params.sessionId, id);
      assert.equal(body.params.prompt.length, 1);
      if (mode === 'permission') {
        send({ id: 'server-approval', method: 'session/request_permission', params: { sessionId: id, options: [{ optionId: 'allow-once' }] } });
      } else if (mode === 'read-file') {
        send({ id: 'file', method: 'fs/read_text_file', params: { sessionId: id, path: '/workspace/input' } });
      } else if (mode === 'error') {
        send({ id: body.id, error: { code: -1, message: 'unsafe diagnostic' } });
      } else if (mode !== 'stall') {
        send({ id: 'unrelated-rpc', result: { stopReason: 'end_turn' } });
        chunk(id, 'bootstrap', '重放的历史片段');
        chunk('foreign-session', 'wrong', '其他任务内容');
        chunk(id, 'hidden', '内部推演', 'agent_thought_chunk');
        chunk(id, 'progress', '暂时意见');
        chunk(id, 'final', '答复');
        chunk(id, 'progress', '迟到的旧消息片段');
        chunk(id, 'final', id);
        send({ id: body.id, result: { stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn' } });
      }
    }
    return new Response(null, { status: 202 });
  }
  return { calls, records, promptSeen, run: (opts = {}) => composeWorkBuddy(question, { fetchImpl, accessToken, timeoutMs: 2000, ...opts }) };
}

test('concurrent turns own independent tasks, channels, replies and ACP credentials', async () => {
  const testCase = fixture();
  assert.deepEqual(await Promise.all([testCase.run(), testCase.run()]), ['答复1', '答复2']);
  for (const record of testCase.records.values()) {
    assert.equal(record.closed, true);
    assert.deepEqual(record.calls.map(call => call.method), ['initialize', 'session/load', 'session/prompt']);
  }
});
test('pending cloud task is queried by its own ID and created only once', async () => {
  const testCase = fixture('creating');
  assert.equal(await testCase.run(), '答复1');
  assert.equal(testCase.calls.filter(call => call.url === tasks).length, 1);
  assert.ok(testCase.calls.some(call => call.method === 'GET' && call.url === tasks + '/1'));
});
test('missing token, unauthorized account or non-official ACP endpoint', async () => {
  const none = fixture();
  await assert.rejects(none.run({ accessToken: '' }), /尚未授权/);
  assert.equal(none.calls.length, 0);
  await assert.rejects(fixture('unauthorized').run(), /401/);
  const bad = fixture('bad-host');
  await assert.rejects(bad.run(), /官方任务通道/);
  assert.equal(bad.calls.length, 1);
});
test('permission is explicitly cancelled and filesystem invocation is rejected', async () => {
  const permission = fixture('permission');
  await assert.rejects(permission.run(), /工具授权/);
  const messages = permission.records.get('1').calls;
  assert.deepEqual(messages.find(item => item.id === 'server-approval').result, { outcome: { outcome: 'cancelled' } });
  assert.equal(messages.at(-1).method, 'session/cancel');
  const file = fixture('read-file');
  await assert.rejects(file.run(), /不支持的客户端操作/);
  assert.equal(file.records.get('1').calls.find(item => item.id === 'file').error.code, -32601);
});
test('RPC errors and incomplete stop reasons do not leak diagnostics or return partial text', async () => {
  await assert.rejects(fixture('error').run(), err => /session\/prompt/.test(err.message) && !err.message.includes('unsafe'));
  await assert.rejects(fixture('truncated').run(), /没有正常完成/);
});
test('timeouts and caller cancellation close SSE and send a bounded cancellation', async () => {
  const stalled = fixture('stall');
  await assert.rejects(stalled.run({ timeoutMs: 45 }), /超时/);
  assert.equal(stalled.records.get('1').closed, true);
  assert.equal(stalled.records.get('1').calls.at(-1).method, 'session/cancel');
  const abort = new AbortController(), interrupted = fixture('stall');
  const running = interrupted.run({ signal: abort.signal });
  await interrupted.promptSeen;
  abort.abort();
  await assert.rejects(running, /已取消/);
  assert.equal(interrupted.records.get('1').closed, true);
});
