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
  console.log('CODEX_LOGIN_TESTS_PASS');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
