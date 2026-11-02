'use strict';
const assert = require('node:assert/strict');
const { CodexBridge } = require('./codex-bridge');

// No credentials or network: exercise login lifecycle and URL validation with RPC stubs.
async function main() {
  const bridge = new CodexBridge(process.cwd());
  bridge.connect = async () => {};
  let starts = 0;
  bridge.rpc = async method => {
    if (method === 'account/read') return { account: null };
    starts++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { authUrl: 'https://auth.openai.com/authorize?test=1' };
  };
  const results = await Promise.all([bridge.login(), bridge.login()]);
  assert.equal(starts, 1);
  assert.equal(results[0].loggedIn, false);
  await bridge.login(); assert.equal(starts, 1);
  bridge.notification({ method: 'account/login/completed', params: { success: false } });
  await bridge.login(); assert.equal(starts, 2);
  bridge.rpc = async () => ({ account: { type: 'chatgpt' } });
  assert.deepEqual(await bridge.login(), { loggedIn: true });
  const invalid = new CodexBridge(process.cwd()); invalid.connect = async () => {};
  invalid.rpc = async method => method === 'account/read' ? { account: null } : { authUrl: 'https://example.com/login' };
  await assert.rejects(invalid.login(), /登录地址/);
  const compose = new CodexBridge(process.cwd());
  compose.createSession = () => ({ id: 'test-session' });
  compose.run = async (id, messages, instructions, execute, model, type) => {
    assert.equal(id, 'test-session'); assert.equal(messages[0].content, 'test-prompt');
    assert.equal(execute, false); assert.equal(model, 'test-model'); assert.equal(type, 'discussion');
    return { id: 'test-job' };
  };
  compose.snapshot = () => ({ status: 'completed', text: 'generated-text' });
  assert.equal(await compose.compose('test-prompt', 'test-model'), 'generated-text');
  compose.snapshot = () => ({ status: 'failed', error: 'upstream-unavailable' });
  await assert.rejects(compose.compose('test-prompt', 'test-model'), /upstream-unavailable/);
  compose.snapshot = () => ({ status: 'completed', text: ' ' });
  await assert.rejects(compose.compose('test-prompt', 'test-model'), /没有返回文本/);
  // The generic discovery failure gets exactly one read-only retry. It must
  // never create a thread/turn, change models or infer login from local state.
  const routingFailure = 'workspace routing discovery failed';
  const accountRead = (replies) => {
    const reader = new CodexBridge(process.cwd()), calls = [];
    reader.localLogin = async () => { throw new Error('Unexpected local login fallback'); };
    reader.rpc = async (method, params) => {
      calls.push({ method, params });
      assert.equal(method, 'account/read'); assert.deepEqual(params, { refreshToken: false });
      const reply = replies[calls.length - 1];
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'Unexpected additional account read'); return reply;
    };
    return { reader, calls };
  };
  const success = { account: { type: 'chatgpt' } };
  let fixture = accountRead([new Error(routingFailure), success]);
  assert.deepEqual(await fixture.reader.readAccount(), success); assert.equal(fixture.calls.length, 2);
  fixture = accountRead([new Error(routingFailure), { account: null }]);
  assert.deepEqual(await fixture.reader.readAccount(), { account: null }); assert.equal(fixture.calls.length, 2);
  for (const message of [routingFailure, 'workspace routing discovery unauthorized (401)', 'workspace routing discovery timed out', 'second read rejected']) {
    const secondError = new Error(message); fixture = accountRead([new Error(routingFailure), secondError]);
    await assert.rejects(fixture.reader.readAccount({ routingTimeoutFallback: true }), error => error === secondError);
    assert.equal(fixture.calls.length, 2, 'A second error must propagate without auth refresh, fallback or a third call');
  }
  for (const message of ['workspace routing discovery failed (503)', 'prefix workspace routing discovery failed', 'unrelated failure']) {
    const firstError = new Error(message); fixture = accountRead([firstError]);
    await assert.rejects(fixture.reader.readAccount({ routingTimeoutFallback: true }), error => error === firstError);
    assert.equal(fixture.calls.length, 1, 'Only the exact discovery error qualifies for retry');
  }
  console.log('CODEX_LOGIN_TESTS_PASS');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
