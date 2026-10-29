'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveCodexBin } = require('./codex-runtime');
const { CodexBridge } = require('./codex-bridge');
const { randomUUID } = require('node:crypto');

const parent = path.resolve(__dirname, '..', '.workbench');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'model-catalog-test-'));
function file(name, age) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, 'test fixture, not executable');
  fs.utimesSync(name, age, age);
  return name;
}

async function main() {
  try {
    const env = { LOCALAPPDATA: path.join(directory, 'local'), APPDATA: path.join(directory, 'roaming') };
    const options = { env, platform: 'win32', arch: 'x64', home: directory };
    assert.equal(resolveCodexBin(options), 'codex');
    const npm = file(path.join(env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'), 1);
    assert.equal(resolveCodexBin(options), npm);
    const old = file(path.join(env.LOCALAPPDATA, 'OpenAI/Codex/bin/old/codex.exe'), 2);
    assert.equal(resolveCodexBin(options), old, 'desktop takes precedence over npm');
    const latest = file(path.join(env.LOCALAPPDATA, 'OpenAI/Codex/bin/latest/codex.exe'), 3);
    fs.mkdirSync(path.join(env.LOCALAPPDATA, 'OpenAI/Codex/bin/newer-but-incomplete'));
    assert.equal(resolveCodexBin(options), latest, 'ignore incomplete desktop installs');
    assert.equal(resolveCodexBin({ ...options, env: { ...env, CODEX_BIN: 'custom-codex.exe' } }), 'custom-codex.exe');
    assert.equal(resolveCodexBin({ ...options, platform: 'linux' }), 'codex');
    const desktopMac = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
    assert.equal(resolveCodexBin({ env: {}, platform: 'darwin', fileExists: file => file === desktopMac }), desktopMac);
    assert.equal(resolveCodexBin({ env: {}, platform: 'darwin', fileExists: () => false }), 'codex');

    const bridge = new CodexBridge(directory);
    bridge.connect = async () => {};
    const requests = [];
    bridge.rpc = async (method, params) => {
      requests.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      return !params.cursor
        ? { data: [{ model: 'gpt-5.5' }, { model: 'gpt-6.1-sol', isDefault: true, defaultReasoningEffort: 'low' }], nextCursor: 'page2' }
        : { data: [{ model: 'gpt-6.1-sol', isDefault: true, defaultReasoningEffort: 'low' }, { model: 'gpt-6-astra' }, { model: 'gpt-6-sol', supportedReasoningEfforts: [{reasoningEffort:'high'}] }, { model: 'internal-review', hidden: true }], nextCursor: null };
    };
    const status = await bridge.status();
    assert.equal(status.model, 'gpt-6-sol');
    assert.equal(status.effort, 'high');
    assert.deepEqual(status.models.map(model => model.model), ['gpt-5.5', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']);
    assert.equal(status.models[1].defaultReasoningEffort, 'low');
    assert.equal(requests.filter(request => request.method === 'model/list').length, 2);
    assert.equal(requests.at(-1).params.cursor, 'page2');
    assert.equal(requests.at(-1).params.includeHidden, false);
    const catalogRpc = bridge.rpc;
    bridge.rpc = async (method, params) => {
      if (method === 'thread/start' || method === 'turn/start') {
        requests.push({method,params});
        return method === 'thread/start' ? {thread:{id:randomUUID()}} : {turn:{id:randomUUID()}};
      }
      return catalogRpc(method,params);
    };
    const session = bridge.createSession();
    const job = await bridge.run(session.id,[{role:'user',content:'fixture'}],'',false,null,'discussion');
    for(let i=0;i<100&&!bridge.jobs.get(job.id).turnId;i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(bridge.snapshot(job.id).model,'gpt-6-sol');
    assert.equal(bridge.snapshot(job.id).effort,'high');
    assert.equal(requests.find(r=>r.method==='thread/start').params.config.model_reasoning_effort,'high');
    assert.equal(requests.find(r=>r.method==='turn/start').params.effort,'high');
    bridge.finish(bridge.jobs.get(job.id),'completed');

    let accountReads = 0;
    let localChecks = 0;
    bridge.localLogin = async () => { localChecks++; return 'chatgpt'; };
    bridge.rpc = async (method, params) => {
      if (method === 'model/list') return { data: [{ model: 'gpt-6.1-sol', isDefault: true }] };
      accountReads++;
      assert.equal(params.refreshToken, false);
      throw new Error('workspace routing discovery timed out');
    };
    assert.equal((await bridge.status()).model, 'gpt-6.1-sol');
    assert.equal(accountReads, 1);
    assert.equal(localChecks, 1, 'use official local login status only for the routing timeout');
    bridge.localLogin = async () => null;
    await assert.rejects(bridge.status(), /workspace routing discovery timed out/);

    bridge.rpc = async method => {
      assert.equal(method, 'account/read');
      return { account: null };
    };
    assert.deepEqual((await bridge.status()).models, []);
    bridge.rpc = async method => method === 'account/read' ? { account: {} } : { data: [], nextCursor: 'same' };
    await assert.rejects(bridge.status(), /分页重复/);
    bridge.rpc = async method => method === 'account/read' ? { account: {} } : { data: null };
    await assert.rejects(bridge.status(), /目录格式无效/);
    console.log('CODEX_MODELS_TESTS_PASS: desktop discovery, fallback, full catalog, exact IDs, account defaults and pagination guards');
  } finally {
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('model-catalog-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
